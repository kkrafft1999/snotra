---
title: Befehle in der Sandbox ausführen
description: Lass Snotra Shell-Befehle und Python ausführen, sieh nach, ob sie isoliert laufen, und gib einem einzelnen Ordner oder Programm mehr Spielraum, wenn es ihn braucht.
sidebar:
  order: 5
---

Snotra kann Shell-Befehle und Python-Code ausführen: `git status`, einen Build, einen Testlauf, ein Skript, das deine Daten sortiert. Beides ist aus, bis du es einschaltest. Unter macOS und Linux läuft dann jeder Lauf in einer Sandbox, die einen Befehl in deinem Projektordner hält.

## Was du brauchst

- **macOS:** nichts; die Sandbox ist eingebaut.
- **Linux:** die Pakete `bubblewrap`, `socat` und `ripgrep`. Das `.deb` installiert sie mit; beim AppImage oder Tarball führst du `sudo apt install bubblewrap socat ripgrep` aus.
- **Windows:** Hier gibt es noch keine Sandbox. Jeder Befehl und jeder Python-Lauf hat deine vollen Rechte — er kann überall lesen und schreiben, ins Netz gehen und Programme starten. Snotra sagt das auf jeder Karte, und die Karte zeigt dir den vollständigen Befehl, bevor er läuft.

## Befehle und Python einschalten

1. Öffne *Einstellungen › Tools & Sicherheit* und klapp die Zeile *Ausführen* auf.
2. Schalte *Shell-Befehle erlauben* ein, *Python-Ausführung erlauben* oder beides.

Befehle laufen unter macOS und Linux in deiner Login-Shell (zsh, bash …), mit dem `PATH` aus deinem Shell-Profil, und unter Windows in PowerShell oder `cmd.exe`. Python sucht Snotra selbst; willst du einen bestimmten Interpreter — eine virtuelle Umgebung mit den Paketen, die du brauchst, zum Beispiel —, stellst du ihn unter *Einstellungen › Tool-Einrichtung* ein.

## Was die Sandbox erlaubt

Ein Befehl oder Python-Lauf in der Sandbox

- schreibt nur im Projektordner und in einem temporären Ordner,
- kann deine Schlüssel, Cloud-Zugangsdaten, Shell-Verläufe und Browserdaten nicht lesen,
- erreicht das Netz nur für die Domains, die der Aufruf nennt. Du gibst sie auf der Karte frei; in *Auto* wird nicht gefragt. `pip install` und `npm install` bekommen ihre Paketquelle automatisch. [seit 1.18] Eine Verbindung zu jedem anderen Host wartet, bis du sie erlaubst oder ablehnst.

Was sie nicht tut: Sie hält einen Lauf nicht davon ab, deine anderen Dateien zu *lesen*, und was er gelesen hat, kann eine Domain erreichen, die du erlaubt hast. Außerdem sperrt Snotra rekursives erzwungenes Löschen wie `rm -rf`, Datenträger-Operationen und das Umschreiben der Git-Historie — eine zusätzliche Absicherung, kein vollständiger Schutz, weil ein Skript dazwischen jede Musterliste umgeht.

## Sehen, ob ein Lauf isoliert ist

**Auf der Karte.** Eine Karte für einen Befehl trägt das Abzeichen *Isoliert* oder, in Bernstein, *Nicht isoliert* mit dem Grund und einem Link zur Sandbox-Einstellung. Sie nennt außerdem Shell, Arbeitsordner und Netzwerkzugriff.

![Eine Freigabekarte mit dem Titel „Ausführung bestätigen“ und dem Abzeichen „Isoliert“: Snotra möchte einen Befehl in zsh ausführen. Darunter Shell, Arbeitsordner, Netzwerk „Kein Zugriff“, Grund und Modus, der Hinweis, dass der Lauf nur im Projektordner und einem temporären Ordner schreibt, der Befehl node src/kalender.js und die Knöpfe „Einmal erlauben“, „Diesen Befehl immer erlauben“ und „Ablehnen“.](screenshots/shell-approval.webp)

**Neben dem Ordnernamen.** Solange Befehle oder Python eingeschaltet sind, steht oben in der Seitenleiste ein Schild neben dem Namen des Ordners: ein schlichtes Schild, solange Läufe in diesem Ordner isoliert sind, ein durchgestrichenes in Bernstein, solange sie es nicht sind. Ein Klick darauf führt zur Sandbox-Einstellung.

![Die linke obere Ecke des Fensters: das Schild neben dem Ordnernamen gartenplaner, über dem Dateibaum.](screenshots/sandbox-shield.webp)

## Wenn die Sandbox etwas blockiert

[seit 1.18] Manchmal braucht ein Befehl mehr, als die Sandbox erlaubt: Ein Build-Tool schreibt seinen Cache unter `~/Library/Caches`, ein Werkzeug liest seine Anmeldung aus `~/.config/gcloud`, `pip` will einen Host, den der Aufruf nicht genannt hat. Die Sandbox verweigert es, und Snotra zeigt dir, was verweigert wurde, statt das Modell raten zu lassen.

**Was du siehst.** Direkt unter den Tool-Schritten der Antwort steht ein Kasten mit dem, was blockiert wurde — Schreiben, Lesen an einem geschützten Ort oder eine Verbindung —, mit Pfad oder Host und dem Grund. Darunter liegt eingeklappt die Rohmeldung der Sandbox. Der Kasten bleibt beim Chat, auch wenn du ihn später wieder öffnest.

**Schreiben oder Lesen erlauben.** Bei Schreiben außerhalb des Projektordners oder Lesen an einem geschützten Ort erscheint direkt nach dem Lauf eine Karte — in jedem Modus, auch in *Auto*:

1. Sieh nach, was blockiert wurde, wie der Lauf ausging und was der Befehl gemeldet hat.
2. Wähle unter *Schreiben erlauben in* genau das Blockierte oder den Ordner eine Ebene höher — den Cache des Programms statt des Unterordners einer Version.
3. Wähle unter *Wie lange* *Nur dieser Lauf* oder *Für diese Sitzung*.
4. Klick auf *Freigeben und wiederholen* oder auf *Ablehnen*. *Esc* lehnt ebenfalls ab.

**Was passiert.** Freigegeben läuft der Befehl ein zweites Mal von vorn, mit genau diesem Pfad offen; für alles andere bleibt die Sandbox an. Was der Befehl beim ersten Mal schon erledigt hat, passiert erneut. Der Kasten sagt danach, wie der zweite Lauf ausging. Für *diese Sitzung* freigegeben bekommen spätere Befehle und Python-Läufe im selben Chat den Pfad ohne Rückfrage; die Freigabe steht unter *Einstellungen › Tools & Sicherheit* bei den Sitzungsfreigaben, wo du sie widerrufen kannst, und sie endet mit dem Chat, einem Moduswechsel oder einem Neustart. Abgelehnt oder unbeantwortet läuft der Befehl nicht noch einmal, und das Modell hat die Ansage, dir zu sagen, was blockiert war, statt auszuweichen.

**Eine Verbindung erlauben.** [seit 1.18] Verbindet sich ein Befehl mit einem Host außerhalb der Netzwerk-Domains seines Aufrufs, wartet die Verbindung, und eine Karte *Sandbox · Verbindung wartet* erscheint, während der Befehl noch läuft — in jedem Modus, auch in *Auto*:

1. Sieh nach, um welchen Host es geht, wie lange die Verbindung schon wartet, welche Hosts schon frei sind und was der Befehl bisher gemeldet hat.
2. Wähle unter *Verbindungen erlauben zu* genau diesen Host oder alle Hosts seiner Domain — `*.pytorch.org` statt `download.pytorch.org:443`. Eine Domain, die sich viele fremde Seiten teilen, etwa `amazonaws.com` oder `github.io`, wird nur Host für Host angeboten.
3. Wähle unter *Wie lange* *Nur dieser Lauf*, *Für diese Sitzung* oder — für einen Host, den dieser Ordner immer wieder braucht — *Für diesen Workspace*.
4. Klick auf *Verbindung erlauben* oder auf *Ablehnen*. *Esc* lehnt ebenfalls ab.

**Was dann passiert.** Erlaubt geht die Verbindung durch, und der Befehl läuft einfach weiter; nichts läuft zweimal. Für *diese Sitzung* erlaubt erreichen spätere Befehle im selben Chat den Host ohne Rückfrage; die Freigabe steht wie ein Pfad bei den Sitzungsfreigaben. Abgelehnt bleibt die Verbindung zu, und der Befehl scheitert von selbst; nach weiteren Hosts wird für ihn nicht mehr gefragt, und das Modell hat die Ansage, nicht auszuweichen. Gibt der Befehl auf, bevor du entscheidest — `pip` zum Beispiel nach 15 Sekunden —, sagt die Karte *Nicht mehr gewartet*, und eine zweite Karte nach dem Lauf bietet den Host mit *Freigeben und wiederholen* an.

**Einen Host für den Ordner offen halten.** [seit 1.22] *Für diesen Workspace* ist die Antwort für einen Server, mit dem du jeden Tag arbeitest. Das Betriebssystem lässt dich das vorher bestätigen und nennt dabei Host und Ordner. Ab dann erreicht jeder Befehl und jeder Python-Lauf in diesem Ordner den Host — in jedem Chat und jedem Modus, auch nach einem Neustart —, und keine Karte fragt mehr nach ihm; für alles andere bleibt die Sandbox an. Der Host steht unter [*Einstellungen › Tools & Sicherheit*](../tools-and-security/#eine-freigabe-widerrufen-oder-zurücksetzen) in der Zeile *Ausführen*, wo du ihn wieder schließen kannst; *Workspace-Regeln zurücksetzen* schließt alle. Angeboten wird die Wahl nur für Verbindungen, nicht in *Immer fragen* und nur dort, wo Snotra sie verschlüsselt speichern kann. Brichst du den Systemdialog ab, bleibt die Karte offen.

**Wenn du geantwortet hast.** [seit 1.21] Ist der Befehl durch, weicht die Karte dem Kasten unter den Tool-Schritten. Hast du alles beantwortet, was er gefragt hat, klappt der Kasten zu einer einzigen Zeile zusammen — zum Beispiel *Die Sandbox hat 1 Zugriff blockiert · abgelehnt · Befehl „cat ~/.aws/config“ ausgeführt* —, und ein Klick öffnet ihn: was blockiert wurde und warum, wie du entschieden hast und was das geöffnet hat, wie der zweite Lauf ausging und die Rohmeldung der Sandbox. Ein Kasten mit etwas, das niemand beantwortet hat, oder mit einer Sperre im zweiten Lauf bleibt offen. Eine Karte, auf die der Befehl nicht mehr gewartet hat (*Nicht mehr gewartet*), bleibt, wie sie ist. Die Ausgabe des ersten Laufs, die die Karte gezeigt hat, wird nicht aufbewahrt.

**Was sich nicht freigeben lässt.** Eine Verbindung, die ein Programm direkt statt über den Proxy der Sandbox aufbaut — `psql` oder `ssh` und `scp`, wenn du sie direkt aufrufst —, lässt sich nur anzeigen: Die Sandbox kann dafür keinen einzelnen Host öffnen. Snotras eigener Speicher, dein Home-Ordner als Ganzes und die Dateien, die die Sandbox immer verschlossen hält, etwa `.bashrc` oder `.git/hooks`, werden nie angeboten.

## Git über SSH nutzen

[seit 1.21.1] Unter macOS erreichen `git fetch`, `git pull`, `git push` und `git ls-remote` auch aus der Sandbox ein SSH-Remote wie `git@gitlab.example.com:team/app.git`. Snotra schickt die SSH-Verbindung von Git über den Proxy der Sandbox. Damit gelten für sie dieselben Regeln wie für jede andere Verbindung, und die Sandbox bleibt an.

### Was du brauchst

- **Den Host in `~/.ssh/known_hosts`.** In der Sandbox kann SSH nicht fragen, ob es einem neuen Host trauen soll. Verbinde dich einmal aus einem Terminal mit ihm — `ssh -T git@gitlab.example.com` — und bestätige seinen Schlüssel.
- **Deinen Schlüssel im ssh-agent.** Die Sandbox hält deine privaten Schlüsseldateien verschlossen; SSH meldet sich stattdessen über den Agent an. Lade den Schlüssel einmal mit `ssh-add --apple-use-keychain ~/.ssh/<schlüssel>`, oder trag `AddKeysToAgent yes` und `UseKeychain yes` in `~/.ssh/config` ein, dann lädt SSH ihn, sobald du ihn das nächste Mal im Terminal benutzt.

### Schritte

1. Bitte wie gewohnt um den Git-Befehl und gib ihn auf der Karte frei.
2. Steht der Host nicht unter den Netzwerk-Domains des Aufrufs, fragt die Karte *Sandbox · Verbindung wartet* nach ihm, etwa nach `gitlab.example.com:22`. Erlaube ihn für *Nur dieser Lauf* oder *Für diese Sitzung* — siehe [Eine Verbindung erlauben](#wenn-die-sandbox-etwas-blockiert).
3. Für ein Remote, das du jeden Tag nutzt, wähl auf dieser Karte *Für diesen Workspace*: Ab dann erreicht Git den Host aus diesem Ordner ohne Rückfrage. Brauchst du ihn aus jedem Ordner, gib `git` stattdessen eine [Freigabe pro Programm](#einem-programm-mehr-spielraum-geben) mit dem Host unter *Domains, die es erreichen darf*.

### Was passiert

Git erreicht den Host über den Proxy. SSH darf in `~/.ssh` die `known_hosts`, die `config` und die öffentlichen Schlüssel (`*.pub`) lesen und mit dem ssh-agent sprechen; die privaten Schlüssel bleiben zu, und die Versuche von SSH, sie zu lesen, erscheinen nicht als blockiert. Ein Befehl in der Sandbox kann sich über den Agent bei den Hosts anmelden, die der Lauf erreichen darf, einen Schlüssel lesen oder kopieren kann er aber nicht. `git push` schreibt ins Remote und ist ein Befehl, den du freigibst wie jeden anderen.

Nur die SSH-Verbindung von Git nimmt diesen Weg. `ssh` oder `scp`, direkt aufgerufen, verbinden sich weiter direkt, und dafür kann die Sandbox keinen einzelnen Host öffnen. Unter Linux kann sich Git über SSH in der Sandbox noch nicht anmelden: Nimm die HTTPS-Adresse des Repositorys, oder schalte die Sandbox für den Ordner ab.

## Die Sandbox für einen Ordner abschalten

Wenn die Sandbox in einem Projekt etwas Berechtigtes verhindert — in ein Nachbar-Repository schreiben, ein Werkzeug, das ins Netz muss, ein älteres `pip` in einer virtuellen Umgebung:

1. Klapp in *Einstellungen › Tools & Sicherheit* die Zeile *Ausführen* auf.
2. Schalte unter *Sandbox für diesen Workspace* die Sandbox ab.
3. Das Betriebssystem fragt: *In diesem Workspace ohne Sandbox ausführen?* Bestätige mit *Ohne Sandbox ausführen*.

Das gilt nur für diesen einen Ordner, nie für alle, und es liegt bei deinen Berechtigungen, nicht im Ordner. Ab dann sagt jede Karte in diesem Ordner *Nicht isoliert*, auch das Modell erfährt es, und in *Auto* zeigt die Modus-Pille *Auto · nicht isoliert*. *Workspace-Regeln zurücksetzen* schaltet die Sandbox wieder ein.

## Einem Programm mehr Spielraum geben

Oft ist es ein einzelnes Programm, das mehr braucht — ein Werkzeug, dessen Anmeldung erneuert werden muss, oder `gh` und `terraform` unter macOS, die in der Sandbox nicht ins Netz kommen. Gib diesem Programm eine Freigabe, statt die Sandbox abzuschalten:

1. Klick in der Zeile *Ausführen* unter *Freigaben pro Programm* auf *Programm hinzufügen*.
2. Gib unter *Programm* seinen Namen ein, so wie du ihn im Terminal tippst, oder seinen vollständigen Pfad. Snotra zeigt, welche Datei es gefunden hat.
3. Trag die *Domains, die es erreichen darf*, ein, eine pro Zeile, und unter *Ordner, in die es zusätzlich schreiben darf* jeden Ordner, in dem es seine Daten hält.
4. Hak unter macOS *Zertifikate über macOS prüfen* an, für Programme in Go wie `gh` und `terraform`. Das schwächt die Isolation etwas ab; der Dialog sagt, wie.
5. Klick auf *Speichern* und bestätige im Systemdialog.

Die Freigabe gilt in jedem Ordner, aber nur, wenn ein Befehl das Programm für sich allein ausführt — ohne Verkettung, Pipes oder Umleitungen — und nur für genau die Datei, die du gewählt hast, nicht für eine gleichnamige Datei in einem Projekt. Die Karte nennt die Freigabe oder sagt, warum sie nicht greift.

## Wenn es nicht klappt

- **Ein Befehl scheitert, und seine Ausgabe sagt nicht, warum.** Schau unter das Tool-Protokoll der Antwort: Der Kasten *Die Sandbox hat … blockiert* listet, was der Lauf erreichen wollte und nicht durfte — siehe [Verfolgen, was Snotra tut](../../chatting/follow-the-work/). Schreiben, Lesen an einem geschützten Ort oder eine Verbindung über den Proxy lässt sich auf einer Karte freigeben; für alles andere gibt eine Freigabe pro Programm oder, für diesen einen Ordner, das Abschalten der Sandbox ihm den Raum.
- **Es gibt einen Kasten, aber keine Karte.** Was blockiert wurde, lässt sich auf einer Karte nicht freigeben: eine direkte Verbindung, Snotras Speicher oder eine Datei, die die Sandbox immer verschlossen hält — oder du hast eine Verbindung desselben Befehls abgelehnt, während er lief. Braucht ein Programm das regelmäßig, gib ihm eine Programm-Freigabe oder schalte die Sandbox für den Ordner ab.
- **Der zweite Lauf wird wieder blockiert.** Der Kasten zeigt, woran der zweite Lauf gescheitert ist; oft braucht ein Programm einen zweiten Ort, etwa eine Konfigurationsdatei neben seinem Cache. Gib den beim nächsten Lauf frei.
- **Linux: Die Karte sagt, die Sandbox brauche Pakete.** Installier `bubblewrap`, `socat` und `ripgrep` und starte Snotra neu.
- **Linux: *Die Sandbox startet auf diesem System nicht*.** Ubuntu ab 24.04 schränkt unprivilegierte User-Namespaces ein, die die Sandbox braucht. Das aufzuheben, ist eine systemweite Entscheidung, und sie liegt bei dir:

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
  ```

  Das hält bis zum nächsten Neustart; damit es bleibt, schreib dieselbe Einstellung in eine Datei unter `/etc/sysctl.d/`. Ein AppArmor-Profil, das `bwrap` User-Namespaces erlaubt, geht ebenso. Starte Snotra danach neu.
- **Git über SSH: *Permission denied (publickey)*.** Der Schlüssel ist nicht im ssh-agent geladen, SSH hat also nichts, womit es sich anmelden kann. Lade ihn mit `ssh-add --apple-use-keychain ~/.ssh/<schlüssel>` und führ den Befehl noch einmal aus — siehe [Git über SSH nutzen](#git-über-ssh-nutzen).
- **Git über SSH: *Host key verification failed*.** Der Host steht noch nicht in `~/.ssh/known_hosts`. Verbinde dich einmal aus einem Terminal mit ihm und bestätige seinen Schlüssel.
- **macOS: `gh`, `terraform` oder ein anderes Go-Programm kommt nicht ins Netz.** Gib ihm eine Freigabe pro Programm mit *Zertifikate über macOS prüfen*.
- ***Sandbox für diesen Workspace* lässt sich nicht abschalten.** Dafür braucht es den verschlüsselten Speicher des Systems; wo es den nicht gibt, bleibt die Einstellung an und sagt, warum.
