# Snotra AI: web search as a core tool

## The goal

Snotra AI is an open-source desktop agent in the spirit of Claude Code Desktop
or ChatGPT Desktop. A dependable web search belongs among its basic tools.

The central architectural decision should be:

> **`web_search` is a stable Snotra interface. The concrete search provider
> stays exchangeable.**

That keeps Snotra independent of individual vendors, pricing models and APIs.

------------------------------------------------------------------------

## 1. A provider abstraction instead of vendor lock-in

The LLM should only ever see the generic `web_search` tool:

``` text
AI Agent
   │
   ▼
web_search
   │
   ├── BraveSearchProvider
   ├── TavilyProvider
   ├── SerperProvider
   ├── GoogleSearchProvider
   └── Custom/MCP Provider
```

What that buys:

-   No vendor lock-in in the agent or in the prompts
-   Providers can be swapped or added later
-   Users can pick the provider they prefer
-   Companies can plug in their own search backends
-   A provider's pricing or API changes don't touch Snotra's tool interface

For a first version, **Brave Search** is a sensible default provider.
**Tavily** and **Serper** work well as additional providers; Google can be added
once access to the official Web Search Service API is available for the user in
question.

------------------------------------------------------------------------

## 2. BYOK as the open-source base model

Snotra should work on the **bring your own key (BYOK)** principle to begin with.

For example:

``` text
Web Search needs a provider.

○ Brave Search     Recommended
○ Tavily
○ Serper
○ Google
○ Custom

API Key: [________________]

[Save securely]
```

An API key belonging to Snotra must not ship inside the open-source desktop
client. Such a key could be extracted from the client regardless of encryption
or obfuscation.

The user's API keys should therefore be stored through the operating system's
secure credential stores:

``` text
macOS     → Keychain
Windows   → Credential Manager
Linux     → Secret Service / libsecret
```

Not in plain text in:

``` text
.env
config.json
settings.json
```

------------------------------------------------------------------------

## 3. Optional, later: a Snotra search proxy

For a particularly easy out-of-the-box experience, Snotra could offer a search
proxy of its own later on:

``` text
Snotra Desktop
      │
      │ search("latest AI agent news")
      ▼
api.snotra.ai/search
      │
      ▼
Search Provider
```

Web search would then work immediately after installation, without the user
having to set up an API key first.

One possible model:

``` text
Snotra Free
→ a small monthly search allowance

after that
→ store your own search API key
```

or, further out, a paid Snotra service.

Before offering anything centrally, though, the respective provider terms have
to be checked regarding end users, passing on search results, API key usage,
data protection and, where applicable, reselling.

For the open-source version, **BYOK should therefore remain the robust base**.

------------------------------------------------------------------------

## 4. One uniform `web_search` interface

The agent should not know provider-specific tools such as `brave_search` or
`tavily_search`.

Instead, something like:

``` json
{
  "name": "web_search",
  "description": "Search the public web for up-to-date information.",
  "parameters": {
    "query": {
      "type": "string"
    },
    "max_results": {
      "type": "integer",
      "default": 8
    },
    "freshness": {
      "enum": ["any", "day", "week", "month", "year"]
    }
  }
}
```

Internally, Snotra can use a provider interface:

``` typescript
interface WebSearchProvider {
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}
```

Every provider is then normalised onto the same result format:

``` typescript
interface WebSearchResult {
  query: string;
  results: SearchResult[];
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  source?: string;
}
```

That keeps all the agent code above it independent of the provider.

------------------------------------------------------------------------

## 5. Keep `web_search` and `web_fetch` deliberately apart

Snotra should offer two separate web core tools:

``` text
web_search(query)
web_fetch(url)
```

Their responsibilities differ:

**`web_search`**

> Which sources are relevant to my question?

**`web_fetch`**

> What does this source actually say?

A typical agent run would be:

``` text
web_search("OpenAI new model announcement")
        ↓
relevant URLs
        ↓
web_fetch(URL 1)
web_fetch(URL 2)
        ↓
compare the information
        ↓
answer with sources
```

This separation gives the agent more control over the research, the choice of
sources and the context it spends.

It also allows the search provider and the web content extraction to evolve
independently of each other.

------------------------------------------------------------------------

## 6. Brave vs. Tavily

### Brave Search

Brave works particularly well as the basic search engine for Snotra:

``` text
Brave
   ↓
Search Results
   ↓
Snotra
   ↓
Fetch / Filter / Rerank / Reason
   ↓
LLM
```

The agent intelligence largely stays inside Snotra.

That fits an open-source agent well, because the individual steps stay
transparent and controllable.

### Tavily

Tavily is cut more towards AI agents and research, and already takes several
processing steps over:

``` text
Search
+ Crawling
+ Extraction
+ Relevance
+ LLM-oriented Context
```

That can be very convenient for users and should therefore be supported as a
provider.

The core architecture should not depend on it, though.

### Serper

Serper is interesting when users explicitly want results from the Google search
ecosystem. It fits well as an optional provider.

### Google

The official Google Web Search Service API should be allowed for
architecturally. Access currently requires additional Google prerequisites,
though, which makes it unsuitable as a universal default for an open-source
project.

------------------------------------------------------------------------

## 7. Recommended core tools for Snotra v1

A lean basic set could look like this:

``` text
CORE TOOLS

filesystem
├── read_file
├── write_file
├── edit_file
├── glob
└── grep

shell
└── execute

web
├── web_search
└── web_fetch

agent
├── task
└── todo
```

With that, the agent already has the three central abilities:

1.  **reading and changing local information**
2.  **running programs and commands**
3.  **researching current information on the web**

Further tool groups can be built on top later.

------------------------------------------------------------------------

## 8. Possible search settings

An example for the Snotra settings:

``` text
Web Search
────────────────────────────

Provider
[ Brave Search ▼ ]

API Key
[ brv_•••••••••••• ]  ✓

Search results
[ 8 ]

Safe Search
[ Moderate ▼ ]

☑ Include page content when useful
```

Options that could be added later:

-   preferred language and region
-   search freshness
-   the maximum number of results
-   domain allow and block lists
-   a search timeout
-   proxy configuration
-   company-internal search providers
-   MCP-based search tools

------------------------------------------------------------------------

## 9. Recommended implementation steps

A sensible order for the work:

1.  **Define a generic `WebSearchProvider` interface**
2.  **Define a normalised search result schema**
3.  **Implement `web_search` as a public agent tool**
4.  **Implement Brave as the first provider**
5.  **Store the API key securely in the OS credential store**
6.  **Implement `web_fetch` separately**
7.  **Preserve sources and URLs throughout the agent's answers**
8.  **Implement Tavily as the second provider**
9.  **Add Serper as an optional, Google-oriented provider**
10. **Allow custom and MCP providers**
11. **Evaluate a Snotra search proxy later, optionally**

------------------------------------------------------------------------

## The architectural principle

The most important guideline:

> **Snotra owns the tool. The provider only supplies the capability behind it.**

The LLM knows `web_search`, not Brave, Tavily or Google.

That lets Snotra decide for itself, in the long run, how research works: search,
fetching, source assessment, reranking, context management and reasoning can all
be improved independently of each other.

### A recommended start

``` text
Snotra web_search
        │
        ├── Brave Search   ← default / BYOK
        ├── Tavily
        ├── Serper
        ├── Google         ← optional, where available
        └── Custom / MCP

Snotra web_fetch
        │
        └── a fetch and extraction layer of our own
```

For a first production-ready open-source version, **Brave + BYOK + the provider
abstraction + a separate `web_fetch`** is a strong starting point.
