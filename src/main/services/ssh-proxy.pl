#!/usr/bin/perl
# ProxyCommand for SSH inside the macOS sandbox (#932).
#
# The sandbox runtime routes git's SSH through its proxy with `nc -X 5`, but
# its proxy requires credentials and BSD nc cannot send them, so every SSH
# connection is refused. This opens the tunnel with an HTTP CONNECT instead,
# carrying the credentials the runtime put into HTTPS_PROXY, then copies bytes
# in both directions. The proxy checks host and port like any other
# connection, so allowances and the sandbox card apply unchanged.
#
# Perl because it ships with macOS and needs nothing else: Snotra's own
# binary cannot run scripts (the RunAsNode fuse is off), and a Node on the
# user's PATH is not a given. Core modules only.
#
# Usage: ssh-proxy.pl <host> <port>
use strict;
use warnings;
use IO::Socket::INET;
use MIME::Base64 qw(encode_base64);

sub fail { print STDERR "snotra-ssh-proxy: $_[0]\n"; exit 1; }

my ($host, $port) = @ARGV;
fail('usage: ssh-proxy.pl <host> <port>') unless defined $port && $port =~ /^\d{1,5}$/ && $host =~ /^[A-Za-z0-9._:\[\]-]+$/;
my $proxy = $ENV{HTTPS_PROXY} || $ENV{https_proxy} || '';
my ($userinfo, $proxyHost, $proxyPort) = $proxy =~ m{^https?://(?:([^@/]*)@)?([^:/]+):(\d+)/?$}
  or fail('no sandbox proxy in HTTPS_PROXY');

my $sock = IO::Socket::INET->new(PeerAddr => $proxyHost, PeerPort => $proxyPort, Proto => 'tcp')
  or fail("cannot reach the sandbox proxy: $!");
binmode $sock;
my $target = $host =~ /:/ && $host !~ /^\[/ ? "[$host]:$port" : "$host:$port";
my $request = "CONNECT $target HTTP/1.1\r\nHost: $target\r\n";
if (defined $userinfo && length $userinfo) {
  (my $plain = $userinfo) =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  $request .= 'Proxy-Authorization: Basic ' . encode_base64($plain, '') . "\r\n";
}
syswrite($sock, "$request\r\n") or fail("cannot write to the sandbox proxy: $!");

# Read the proxy's answer up to the blank line; anything after it is already
# the server's first bytes and goes to ssh.
my $head = '';
while ($head !~ /\r\n\r\n/) {
  my $n = sysread($sock, my $chunk, 4096);
  fail('the sandbox proxy closed the connection') unless $n;
  $head .= $chunk;
  fail('the sandbox proxy sent an oversized answer') if length $head > 65536;
}
my ($status, $rest) = split /\r\n\r\n/, $head, 2;
my ($code) = $status =~ m{^HTTP/\d\.\d (\d{3})};
unless (defined $code && $code eq '200') {
  (my $line = $status) =~ s/\r\n.*//s;
  fail("the sandbox refused the connection to $target ($line)");
}

binmode STDIN;
binmode STDOUT;

# Copies until the source closes or the target stops taking bytes.
sub pump {
  my ($from, $to) = @_;
  while (1) {
    my $n = sysread($from, my $buf, 65536);
    return unless $n;
    my $off = 0;
    while ($off < $n) {
      my $w = syswrite($to, $buf, $n - $off, $off);
      return unless $w;
      $off += $w;
    }
  }
}

syswrite(STDOUT, $rest) if length $rest;

# One process per direction; when the server side closes, both end.
my $pid = fork();
fail("fork failed: $!") unless defined $pid;
if ($pid == 0) {
  pump(\*STDIN, $sock);
  shutdown($sock, 1);
  exit 0;
}
pump($sock, \*STDOUT);
kill 'TERM', $pid;
waitpid($pid, 0);
exit 0;
