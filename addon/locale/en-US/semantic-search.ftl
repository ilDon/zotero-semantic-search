semsearch-window-title = Semantic Search
semsearch-menu-open = Semantic Search…
semsearch-menu-item = Semantic Search
semsearch-menu-find-similar = Find Similar Documents
semsearch-menu-search-abstract = Search Passages Like This Abstract
semsearch-menu-index = Index Now
semsearch-menu-reindex = Re-index (full-text passages)
semsearch-menu-exclude = Exclude from Semantic Search
semsearch-menu-include = Include in Semantic Search

semsearch-menuitem-open =
    .label = Semantic Search…
semsearch-menuitem-item =
    .label = Semantic Search
semsearch-menuitem-find-similar =
    .label = Find Similar Documents
semsearch-menuitem-search-abstract =
    .label = Search Passages Like This Abstract
semsearch-menuitem-index =
    .label = Index Now
semsearch-menuitem-reindex =
    .label = Re-index (full-text passages)
semsearch-menuitem-exclude =
    .label = Exclude from Semantic Search
semsearch-menuitem-include =
    .label = Include in Semantic Search

semsearch-pane-header =
    .label = Semantic Search
semsearch-pane-sidenav =
    .tooltiptext = Semantic Search
semsearch-pane-indexed = Indexed: { $count } passages ({ $date })
semsearch-pane-indexed-legacy = Indexed by the previous version: { $count } sections ({ $date })
semsearch-pane-not-indexed = Not indexed yet
semsearch-pane-excluded = Excluded ({ $reason })
semsearch-pane-no-pdf = No PDF attachment
semsearch-pane-indexing = Indexing… { $done }/{ $total }
semsearch-pane-queued = Waiting to be indexed
semsearch-pane-similar = Similar documents
semsearch-pane-similar-none = No similar documents found

semsearch-prefs-title = Semantic Search
semsearch-prefs-search = Search
semsearch-prefs-min-similarity = Minimum similarity:
semsearch-prefs-max-results = Maximum results:
semsearch-prefs-indexing = Indexing
semsearch-prefs-auto-index = Automatically index new PDFs
semsearch-prefs-workers = Parallel indexing workers:
semsearch-prefs-model = Embedding model
semsearch-prefs-model-desc = LEALLA-large (multilingual, 109 languages), run locally in Zotero. The same model used by the previous version, so existing indexes remain valid.
semsearch-prefs-database = Database
semsearch-prefs-mcp = MCP server for AI assistants
semsearch-prefs-mcp-enable = Enable the local MCP endpoint
semsearch-prefs-mcp-desc = Lets AI assistants on this computer (Claude Code, Claude Desktop, …) search your library. Only local programs can connect.
semsearch-prefs-mcp-claude-code = Claude Code:
semsearch-prefs-mcp-desktop = Claude Desktop (claude_desktop_config.json):
semsearch-prefs-copy = Copy
semsearch-prefs-maintenance = Maintenance
semsearch-prefs-rebuild-cache = Rebuild vector cache
semsearch-prefs-upgrade-legacy = Re-index documents of the previous version…
semsearch-prefs-upgrade-legacy-confirm = { $count } documents were indexed by the previous version, which only embedded the beginning of every 2500-character section. Re-indexing embeds their full text and stores passage text and pages, but takes many hours, produces about 5 times more passages (the database and memory use grow accordingly) and changes their passages (results saved in the history for them may no longer point to the right passage). Continue?

semsearch-model-missing = The embedding model (590 MB) must be downloaded once before searching.
semsearch-model-download = Download model
semsearch-model-downloading = Downloading model… { $percent }%
semsearch-model-verifying = Verifying download…
semsearch-model-ready = Model ready
semsearch-model-error = Download failed: { $error }

semsearch-query-placeholder =
    .placeholder = Write a concept, a sentence or a paragraph from your text…
semsearch-search = Search
semsearch-rerun = Search again
semsearch-threshold = Min. similarity
semsearch-group = Group by document
semsearch-filter-all = All results
semsearch-filter-hide-irrelevant = Hide irrelevant
semsearch-filter-todo = To review
semsearch-filter-cited = Cited
semsearch-filter-irrelevant = Irrelevant
semsearch-history = Saved searches
semsearch-history-filter =
    .placeholder = Filter searches
semsearch-history-empty = No saved searches yet
semsearch-history-delete =
    .title = Delete this search
semsearch-excluded = Excluded documents ({ $count })
semsearch-excluded-title = Excluded documents
semsearch-excluded-empty = No excluded documents
semsearch-excluded-include = Include again
semsearch-reason-encrypted = encrypted
semsearch-reason-no_text = no text
semsearch-reason-manual = excluded manually
semsearch-reason-duplicate = duplicate
semsearch-reason-unreadable = unreadable
semsearch-reason-other = other

semsearch-results-count = { $count ->
    [one] 1 passage
   *[other] { $count } passages
}
semsearch-results-docs = { $count ->
    [one] in 1 document
   *[other] in { $count } documents
}
semsearch-results-from-history = saved on { $date }
semsearch-results-none = No passage reached the minimum similarity. Try a longer query (a full sentence or paragraph) or lower the threshold.
semsearch-searching = Searching…
semsearch-save-collection = Save as collection
semsearch-copy-list = Copy list
semsearch-collection-name = Semantic search: { $query }
semsearch-collection-created = Collection “{ $name }” created with { $count } items.

semsearch-show-in-library = Show in library
semsearch-open-pdf = Open PDF
semsearch-open-pdf-page = Open PDF (p. { $page })
semsearch-copy-prompt = Copy prompt
semsearch-copy-citation = Copy citation
semsearch-exclude-doc = Exclude document
semsearch-status-todo = To review
semsearch-status-cited = Cited
semsearch-status-irrelevant = Irrelevant
semsearch-approximate = Approximate position (document indexed by the previous version)
semsearch-locate = Find exact passage
semsearch-locating = Locating…
semsearch-page = p. { $page }
semsearch-also-in = Identical PDF also in { $count } other items
semsearch-matched = matches: “{ $text }”
semsearch-copied = Copied
semsearch-missing-item = Item no longer in the library

semsearch-index-status = { $docs } documents · { $passages } passages
semsearch-index-loading = Loading index…
semsearch-index-building = Preparing the index (first time only)… { $done }/{ $total }
semsearch-index-db = Optimising the database (first time only)…
semsearch-index-new = Index new PDFs
semsearch-index-pause = Pause
semsearch-index-resume = Resume
semsearch-index-cancel = Stop
semsearch-index-running = Indexing { $done }/{ $total }
semsearch-index-current = { $title } ({ $done }/{ $total })
semsearch-index-uptodate = All PDFs are indexed
semsearch-index-found = { $count } new PDFs to index

semsearch-similar-title = Documents similar to “{ $title }”
semsearch-error = Error: { $message }

semsearch-type-filter-all = Type: all
semsearch-type-filter-some = Type: { $types }
semsearch-type-filter-reset = Show all types
semsearch-ocr = Run OCR
semsearch-ocr-running = OCR running in the terminal…
semsearch-prefs-ocr-languages = OCR languages (tesseract codes, e.g. ita+eng):
