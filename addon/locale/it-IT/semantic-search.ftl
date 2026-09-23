semsearch-window-title = Ricerca semantica
semsearch-menu-open = Ricerca semantica…
semsearch-menu-item = Ricerca semantica
semsearch-menu-find-similar = Trova documenti simili
semsearch-menu-search-abstract = Cerca passaggi simili all’abstract
semsearch-menu-index = Indicizza ora
semsearch-menu-reindex = Reindicizza (passaggi a testo completo)
semsearch-menu-exclude = Escludi dalla ricerca semantica
semsearch-menu-include = Includi nella ricerca semantica

semsearch-menuitem-open =
    .label = Ricerca semantica…
semsearch-menuitem-item =
    .label = Ricerca semantica
semsearch-menuitem-find-similar =
    .label = Trova documenti simili
semsearch-menuitem-search-abstract =
    .label = Cerca passaggi simili all’abstract
semsearch-menuitem-index =
    .label = Indicizza ora
semsearch-menuitem-reindex =
    .label = Reindicizza (passaggi a testo completo)
semsearch-menuitem-exclude =
    .label = Escludi dalla ricerca semantica
semsearch-menuitem-include =
    .label = Includi nella ricerca semantica

semsearch-pane-header =
    .label = Ricerca semantica
semsearch-pane-sidenav =
    .tooltiptext = Ricerca semantica
semsearch-pane-indexed = Indicizzato: { $count } passaggi ({ $date })
semsearch-pane-indexed-legacy = Indicizzato dalla versione precedente: { $count } sezioni ({ $date })
semsearch-pane-not-indexed = Non ancora indicizzato
semsearch-pane-excluded = Escluso ({ $reason })
semsearch-pane-no-pdf = Nessun allegato PDF
semsearch-pane-indexing = Indicizzazione… { $done }/{ $total }
semsearch-pane-queued = In coda per l’indicizzazione
semsearch-pane-similar = Documenti simili
semsearch-pane-similar-none = Nessun documento simile trovato

semsearch-prefs-title = Ricerca semantica
semsearch-prefs-search = Ricerca
semsearch-prefs-min-similarity = Similarità minima:
semsearch-prefs-max-results = Numero massimo di risultati:
semsearch-prefs-indexing = Indicizzazione
semsearch-prefs-auto-index = Indicizza automaticamente i nuovi PDF
semsearch-prefs-workers = Processi di indicizzazione in parallelo:
semsearch-prefs-model = Modello di embedding
semsearch-prefs-model-desc = LEALLA-large (multilingue, 109 lingue), eseguito localmente in Zotero. È lo stesso modello della versione precedente: gli indici esistenti restano validi.
semsearch-prefs-database = Database
semsearch-prefs-mcp = Server MCP per assistenti AI
semsearch-prefs-mcp-enable = Attiva l’endpoint MCP locale
semsearch-prefs-mcp-desc = Permette agli assistenti AI su questo computer (Claude Code, Claude Desktop, …) di cercare nella tua biblioteca. Possono collegarsi solo i programmi locali.
semsearch-prefs-mcp-claude-code = Claude Code:
semsearch-prefs-mcp-desktop = Claude Desktop (claude_desktop_config.json):
semsearch-prefs-copy = Copia
semsearch-prefs-maintenance = Manutenzione
semsearch-prefs-rebuild-cache = Ricostruisci la cache dei vettori
semsearch-prefs-upgrade-legacy = Reindicizza i documenti della versione precedente…
semsearch-prefs-upgrade-legacy-confirm = { $count } documenti sono stati indicizzati dalla versione precedente, che codificava solo l’inizio di ogni sezione di 2500 caratteri. La reindicizzazione codifica tutto il testo e salva testo e pagina dei passaggi, ma richiede molte ore, produce circa 5 volte più passaggi (database e memoria usata crescono di conseguenza) e cambia i loro passaggi (i risultati salvati nella cronologia per questi documenti potrebbero non puntare più al passaggio giusto). Continuare?

semsearch-model-missing = Prima di cercare occorre scaricare una volta il modello di embedding (590 MB).
semsearch-model-download = Scarica il modello
semsearch-model-downloading = Download del modello… { $percent }%
semsearch-model-verifying = Verifica del download…
semsearch-model-ready = Modello pronto
semsearch-model-error = Download non riuscito: { $error }

semsearch-query-placeholder =
    .placeholder = Scrivi un concetto, una frase o un paragrafo del tuo testo…
semsearch-search = Cerca
semsearch-rerun = Ripeti la ricerca
semsearch-threshold = Similarità min.
semsearch-group = Raggruppa per documento
semsearch-filter-all = Tutti i risultati
semsearch-filter-hide-irrelevant = Nascondi irrilevanti
semsearch-filter-todo = Da vedere
semsearch-filter-cited = Citati
semsearch-filter-irrelevant = Irrilevanti
semsearch-history = Ricerche salvate
semsearch-history-filter =
    .placeholder = Filtra le ricerche
semsearch-history-empty = Nessuna ricerca salvata
semsearch-history-delete =
    .title = Elimina questa ricerca
semsearch-excluded = Documenti esclusi ({ $count })
semsearch-excluded-title = Documenti esclusi
semsearch-excluded-empty = Nessun documento escluso
semsearch-excluded-include = Includi di nuovo
semsearch-reason-encrypted = cifrato
semsearch-reason-no_text = senza testo
semsearch-reason-manual = escluso manualmente
semsearch-reason-duplicate = duplicato
semsearch-reason-unreadable = illeggibile
semsearch-reason-other = altro

semsearch-results-count = { $count ->
    [one] 1 passaggio
   *[other] { $count } passaggi
}
semsearch-results-docs = { $count ->
    [one] in 1 documento
   *[other] in { $count } documenti
}
semsearch-results-from-history = salvata il { $date }
semsearch-results-none = Nessun passaggio ha raggiunto la similarità minima. Prova una ricerca più lunga (una frase o un paragrafo intero) o abbassa la soglia.
semsearch-searching = Ricerca in corso…
semsearch-save-collection = Salva come collezione
semsearch-copy-list = Copia elenco
semsearch-collection-name = Ricerca semantica: { $query }
semsearch-collection-created = Collezione «{ $name }» creata con { $count } elementi.

semsearch-show-in-library = Mostra nella biblioteca
semsearch-open-pdf = Apri PDF
semsearch-open-pdf-page = Apri PDF (p. { $page })
semsearch-copy-prompt = Copia prompt
semsearch-copy-citation = Copia citazione
semsearch-exclude-doc = Escludi documento
semsearch-status-todo = Da vedere
semsearch-status-cited = Citato
semsearch-status-irrelevant = Irrilevante
semsearch-approximate = Posizione stimata (documento indicizzato dalla versione precedente)
semsearch-locate = Trova il passaggio esatto
semsearch-locating = Ricerca del passaggio…
semsearch-page = p. { $page }
semsearch-also-in = PDF identico anche in altri { $count } elementi
semsearch-matched = corrisponde a: «{ $text }»
semsearch-copied = Copiato
semsearch-missing-item = Elemento non più presente nella biblioteca

semsearch-index-status = { $docs } documenti · { $passages } passaggi
semsearch-index-loading = Caricamento dell’indice…
semsearch-index-building = Preparazione dell’indice (solo la prima volta)… { $done }/{ $total }
semsearch-index-db = Ottimizzazione del database (solo la prima volta)…
semsearch-index-new = Indicizza i nuovi PDF
semsearch-index-pause = Pausa
semsearch-index-resume = Riprendi
semsearch-index-cancel = Interrompi
semsearch-index-running = Indicizzazione { $done }/{ $total }
semsearch-index-current = { $title } ({ $done }/{ $total })
semsearch-index-uptodate = Tutti i PDF sono indicizzati
semsearch-index-found = { $count } nuovi PDF da indicizzare

semsearch-similar-title = Documenti simili a «{ $title }»
semsearch-error = Errore: { $message }
