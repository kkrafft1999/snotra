# Snotra AI: Web Search als Core Tool

## Ziel

Snotra AI ist eine Open-Source-Desktop-Agent-Lösung im Stil von Claude
Code Desktop oder ChatGPT Desktop. Eine zuverlässige Websuche sollte
dabei zu den grundlegenden Tools gehören.

Die zentrale Architekturentscheidung sollte sein:

> **`web_search` ist eine stabile Snotra-Schnittstelle. Der konkrete
> Suchanbieter bleibt austauschbar.**

Damit bleibt Snotra unabhängig von einzelnen Anbietern, Preismodellen
und APIs.

------------------------------------------------------------------------

## 1. Provider-Abstraktion statt Vendor Lock-in

Das LLM sollte immer nur das generische Tool `web_search` sehen:

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

Vorteile:

-   Kein Vendor Lock-in im Agenten oder in den Prompts
-   Anbieter können später ausgetauscht oder ergänzt werden
-   Nutzer können ihren bevorzugten Anbieter wählen
-   Firmen können eigene Search-Backends integrieren
-   Preis- oder API-Änderungen eines Providers betreffen nicht die
    Snotra-Tool-Schnittstelle

Für eine erste Version ist **Brave Search** ein sinnvoller
Default-Provider. **Tavily** und **Serper** eignen sich als zusätzliche
Provider; Google kann ergänzt werden, sobald der Zugang zur offiziellen
Web Search Service API für den jeweiligen Nutzer verfügbar ist.

------------------------------------------------------------------------

## 2. BYOK als Open-Source-Grundmodell

Snotra sollte zunächst nach dem Prinzip **Bring Your Own Key (BYOK)**
funktionieren.

Beispiel:

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

Ein Snotra-eigener API-Key darf nicht im Open-Source-Desktop-Client
ausgeliefert werden. Ein solcher Schlüssel könnte unabhängig von
Verschlüsselung oder Obfuscation aus dem Client extrahiert werden.

API-Schlüssel des Nutzers sollten deshalb über die sicheren Credential
Stores des Betriebssystems gespeichert werden:

``` text
macOS     → Keychain
Windows   → Credential Manager
Linux     → Secret Service / libsecret
```

Nicht als Klartext in:

``` text
.env
config.json
settings.json
```

------------------------------------------------------------------------

## 3. Optional später: Snotra Search Proxy

Für eine besonders einfache Out-of-the-box-Erfahrung könnte Snotra
später einen eigenen Search Proxy anbieten:

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

Damit könnte Web Search unmittelbar nach der Installation funktionieren,
ohne dass der Nutzer zunächst einen API-Key einrichten muss.

Ein mögliches Modell wäre beispielsweise:

``` text
Snotra Free
→ kleines monatliches Search-Kontingent

danach
→ eigenen Search API Key hinterlegen
```

oder perspektivisch ein kostenpflichtiger Snotra-Dienst.

Vor einer solchen zentralen Bereitstellung müssen jedoch die jeweiligen
Provider-Bedingungen hinsichtlich Endnutzern, Weitergabe von
Suchergebnissen, API-Key-Nutzung, Datenschutz und gegebenenfalls
Reselling geprüft werden.

Für die Open-Source-Version sollte **BYOK deshalb die robuste Basis
bleiben**.

------------------------------------------------------------------------

## 4. Einheitliche `web_search`-Schnittstelle

Der Agent sollte keine anbieterspezifischen Tools wie `brave_search`
oder `tavily_search` kennen.

Stattdessen beispielsweise:

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

Intern kann Snotra ein Provider-Interface verwenden:

``` typescript
interface WebSearchProvider {
  search(request: WebSearchRequest): Promise<WebSearchResult>;
}
```

Alle Provider werden anschließend auf dasselbe Resultatformat
normalisiert:

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

Dadurch bleibt der gesamte darüberliegende Agent-Code
providerunabhängig.

------------------------------------------------------------------------

## 5. `web_search` und `web_fetch` bewusst trennen

Snotra sollte zwei eigenständige Web-Core-Tools anbieten:

``` text
web_search(query)
web_fetch(url)
```

Die Verantwortlichkeiten sind unterschiedlich:

**`web_search`**

> Welche Quellen sind für meine Frage relevant?

**`web_fetch`**

> Was steht tatsächlich in dieser Quelle?

Ein typischer Agentenablauf wäre:

``` text
web_search("OpenAI new model announcement")
        ↓
relevante URLs
        ↓
web_fetch(URL 1)
web_fetch(URL 2)
        ↓
Informationen vergleichen
        ↓
Antwort mit Quellen
```

Diese Trennung gibt dem Agenten mehr Kontrolle über Recherche,
Quellenwahl und Kontextverbrauch.

Sie ermöglicht außerdem, Search Provider und Web-Content-Extraction
unabhängig voneinander weiterzuentwickeln.

------------------------------------------------------------------------

## 6. Brave vs. Tavily

### Brave Search

Brave eignet sich besonders gut als grundlegende Search Engine für
Snotra:

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

Die Agent Intelligence bleibt damit weitgehend in Snotra.

Das passt gut zu einem Open-Source-Agenten, weil die einzelnen Schritte
transparent und kontrollierbar bleiben.

### Tavily

Tavily ist stärker auf AI Agents und Research zugeschnitten und
übernimmt bereits mehrere Verarbeitungsschritte:

``` text
Search
+ Crawling
+ Extraction
+ Relevance
+ LLM-oriented Context
```

Das kann für Nutzer sehr praktisch sein und sollte deshalb als Provider
unterstützt werden.

Für die Kernarchitektur sollte Snotra aber nicht davon abhängig sein.

### Serper

Serper ist interessant, wenn Nutzer explizit Ergebnisse aus dem
Google-Search-Ökosystem wünschen. Es eignet sich daher gut als
optionaler Provider.

### Google

Die offizielle Google Web Search Service API sollte architektonisch
vorgesehen werden. Der Zugang setzt derzeit jedoch zusätzliche
Google-Voraussetzungen voraus und eignet sich deshalb nicht als
universeller Default für ein Open-Source-Projekt.

------------------------------------------------------------------------

## 7. Empfohlene Core Tools für Snotra v1

Eine schlanke Grundausstattung könnte so aussehen:

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

Damit besitzt der Agent bereits die drei zentralen Fähigkeiten:

1.  **lokale Informationen lesen und verändern**
2.  **Programme und Befehle ausführen**
3.  **aktuelle Informationen aus dem Web recherchieren**

Darauf können später weitere Tool-Gruppen aufgebaut werden.

------------------------------------------------------------------------

## 8. Mögliche Search-Einstellungen

Beispiel für die Snotra-Einstellungen:

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

Zusätzlich könnten später beispielsweise folgende Optionen hinzukommen:

-   bevorzugte Sprache/Region
-   Search-Freshness
-   maximale Zahl von Ergebnissen
-   Domain Allow-/Blocklists
-   Search Timeout
-   Proxy-Konfiguration
-   Firmeninterne Search Provider
-   MCP-basierte Search Tools

------------------------------------------------------------------------

## 9. Empfohlene Umsetzungsschritte

Für die Weiterentwicklung bietet sich folgende Reihenfolge an:

1.  **Generisches `WebSearchProvider`-Interface definieren**
2.  **Normalisiertes Search-Result-Schema definieren**
3.  **`web_search` als öffentliches Agent Tool implementieren**
4.  **Brave als ersten Provider implementieren**
5.  **API-Key sicher über OS Credential Store speichern**
6.  **`web_fetch` separat implementieren**
7.  **Quellen/URLs in Agentenantworten durchgängig erhalten**
8.  **Tavily als zweiten Provider implementieren**
9.  **Serper als optionalen Google-orientierten Provider ergänzen**
10. **Custom/MCP Provider ermöglichen**
11. **Später optional einen Snotra Search Proxy evaluieren**

------------------------------------------------------------------------

## Architekturprinzip

Die wichtigste Leitlinie lautet:

> **Snotra besitzt das Tool. Der Provider liefert nur die Fähigkeit
> dahinter.**

Das LLM kennt `web_search`, nicht Brave, Tavily oder Google.

Dadurch kann Snotra langfristig selbst bestimmen, wie Recherche
funktioniert: Search, Fetching, Quellenbewertung, Reranking, Context
Management und Reasoning können unabhängig voneinander verbessert
werden.

### Empfohlener Start

``` text
Snotra web_search
        │
        ├── Brave Search   ← Default / BYOK
        ├── Tavily
        ├── Serper
        ├── Google         ← optional, wenn verfügbar
        └── Custom / MCP

Snotra web_fetch
        │
        └── eigener Fetch-/Extraction-Layer
```

Für eine erste produktive Open-Source-Version ist **Brave + BYOK +
Provider-Abstraktion + separates `web_fetch`** eine starke
Ausgangsbasis.
