# Meeting Report Generator — technische documentatie

Interne Winsol-tool die van een meeting-transcript (Teams .vtt, .txt, .docx) een gestructureerd verslag maakt, met export naar Word en optioneel een audioversie (podcast/training). Live op `https://winsol-belgie.github.io/meeting-report-generator/`. Toegang enkel met login.

Dit document bestaat uit twee delen: (1) hoe de app werkt, (2) wat er moet gebeuren als de oorspronkelijke beheerder (Gwenn Vanthournout) er niet meer is.

---

## Deel 1 — Hoe de app werkt

### 1.1 Architectuur in het kort

De app bestaat uit twee onderdelen die samen geen eigen server hebben:

- **Frontend** — één statische webpagina (`index.html`), gehost op GitHub Pages. Alle logica die met het transcript te maken heeft, draait in de browser van de gebruiker: bestanden inlezen, prompt opbouwen, resultaat tonen, bewerken, exporteren naar Word.
- **Backend** — één Cloudflare Worker (`worker.js`). Dit is een klein stukje serverless code dat dient als beveiligde doorgeefluik: het beheert de login en bewaart de API-sleutels van de AI-diensten, zodat die nooit in de browser terechtkomen.

De AI-diensten zelf zijn externe leveranciers: Anthropic (Claude, voor het verslag) en Microsoft Azure (spraak, in alle zes talen).

```
Browser (index.html op GitHub Pages)
   │  1. login  ──────────────►  Cloudflare Worker ──► Workers KV (gebruikers + sessies)
   │  2. rapport (tekst) ─────►  Worker ──► Anthropic Claude  (streaming terug)
   │  3. audio (tekst) ───────►  Worker ──► Azure Neural TTS
   ▼
Word-export en audiobestand worden in de browser samengesteld
```

### 1.2 Bestanden in de repo

| Bestand | Functie |
|---|---|
| `index.html` | De volledige frontend: loginscherm, formulier, verslaggeneratie, bewerkmodus, Word-export, audio, gebruikersbeheer (admin), vertalingen van de interface (NL/FR/EN/DE/ES/IT). Bevat de URL van de worker (`WORKER_URL`). |
| `styles.css` | Winsol SO!Crates-huisstijl, gedeeld met de andere Winsol-apps (zoals de Presentatievertaler). |
| `Winsol_Avatar_150px.png` | Logo. |
| `people.json` | Lijst van medewerkers (naam + functie) voor de autocomplete bij deelnemers. Handmatig onderhouden. |
| `worker.js` | De Cloudflare Worker: login/sessies, doorsturen naar Anthropic en Azure, admin-route om gebruikers bij te werken. |
| `wrangler.toml` | Configuratie van de worker: naam (`meeting-report-generator`), KV-koppeling (`MEETING_KV`). Wordt gebruikt bij `npx wrangler deploy`. |
| `README.md` | Dit document. |

Niet in de repo, maar wel nodig: de **secrets** in Cloudflare (zie 2.2). Die staan nergens in de code.

### 1.3 Datastroom stap voor stap

1. **Inloggen.** De gebruiker typt gebruikersnaam en wachtwoord. De browser stuurt die naar de worker (`mode: login`). De worker berekent `sha256(wachtwoord + PASSWORD_PEPPER)` en vergelijkt met de opgeslagen hash in KV (`user:<naam>`). Bij een match maakt de worker een willekeurig token (`session:<token>` in KV, geldig 12 uur, of 30 dagen met "Blijf aangemeld") en geeft dat terug. De browser bewaart het token en stuurt het bij elke aanvraag mee in de header `X-Auth-Token`. Zonder geldig token weigert de worker alles (401).
2. **Bestanden inlezen.** Het transcript (.vtt/.txt/.docx) en eventuele extra documenten (.docx/.txt/.pdf, max 10 MB per bestand) worden **in de browser** omgezet naar tekst (mammoth voor Word, pdf.js voor PDF). Het transcript wordt afgekapt op 200.000 tekens (±50.000 tokens).
3. **Verslag genereren.** De browser bouwt een prompt (afhankelijk van het gekozen verslagtype, de taal, deelnemers, extra instructies) en stuurt die naar de worker. De worker stuurt door naar Anthropic (standaard `claude-sonnet-4-6`, instelbaar via de Cloudflare-variabele `CLAUDE_MODEL`; max 8000 uitvoertokens) en geeft het antwoord als stream terug, zodat de tekst live verschijnt. De gebruiker kan stoppen; de reeds gegenereerde tekst blijft behouden.
4. **Nalezen en bewerken.** Het verslag staat als markdown in het geheugen van de browser. Met "Bewerken" kan de gebruiker fouten verbeteren (bv. verkeerde spreker) vóór export of audio.
5. **Exporteren.** De Word-export (.doc) wordt volledig in de browser gemaakt.
6. **Audio (optioneel).** De verslagtekst wordt in stukken gesneden en per stuk naar de worker gestuurd. Alle talen gaan naar Azure Neural TTS, met SSML voor pauzes. Stemmen (vrouw/man): NL `nl-BE-Dena/Arnaud`, FR `fr-FR-Denise/Henri`, EN `en-GB-Sonia/Ryan`, DE `de-DE-Katja/Conrad`, ES `es-ES-Elvira/Alvaro`, IT `it-IT-Elsa/Diego` (zie `VOICES` in `worker.js`). Voor Nederlands bestaat een uitspraaklijstje `NL_PRONUNCIATIONS` in `index.html`. De stukken worden in de browser aan elkaar geplakt tot één mp3.
7. **Gebruikersbeheer (admin).** Een admin uploadt een Excel (kolommen `USER`, `PW`, `ROLE` = admin of user). De browser leest die in en stuurt de rijen naar de worker, die de wachtwoorden hasht en in KV opslaat. Bestaande gebruikers die niet in het bestand staan, blijven ongewijzigd.

### 1.4 Waar gebeurt welke verwerking?

| Wat | Waar |
|---|---|
| Bestanden lezen, tekst extraheren, prompt opbouwen | Browser van de gebruiker |
| Verslag opmaken, bewerken, Word-export, audio samenvoegen | Browser van de gebruiker |
| Login, sessies, API-sleutels, doorsturen naar AI | Cloudflare Worker |
| Verslag schrijven | Anthropic (Claude) |
| Spraak (alle talen) | Microsoft Azure Speech (regio West-Europa) |

**Wat wordt bewaard?** Enkel in Cloudflare KV: gebruikers (naam, gehasht wachtwoord, rol) en sessietokens. Transcripts, verslagen en audio worden door onze code nergens opgeslagen. De tekst gaat wel tijdelijk naar Anthropic en/of Microsoft om verwerkt te worden (zie 2.5 over privacy).

### 1.5 Geschatte kosten

Indicatieve bedragen op basis van de publieke tarieven bij het schrijven van dit document. **Controleer de actuele prijzen** bij de leveranciers; tarieven en modellen wijzigen regelmatig.

| Onderdeel | Tarief (indicatief) | Typisch gebruik | Kost |
|---|---|---|---|
| Claude Sonnet (verslag) | ±3 USD per miljoen invoertokens, ±15 USD per miljoen uitvoertokens | Meeting van 1 uur: ±15.000 tokens in, ±4.000 tokens uit | ±0,10 USD per verslag |
| Claude, zwaarste geval | 200.000 tekens in (±50.000 tokens), 8.000 tokens uit | Zeer lange meeting | ±0,25–0,30 USD |
| Azure Neural TTS (alle talen) | ±16 USD per miljoen tekens; gratis niveau (F0) tot 500.000 tekens/maand | Verslag van ±9.000 tekens | Gratis binnen F0, anders ±0,15 USD |
| Cloudflare Workers + KV | Gratis niveau: 100.000 aanvragen/dag | Enkele honderden aanvragen per dag | 0 EUR |
| GitHub Pages | Gratis | — | 0 EUR |

Bij 50 verslagen per maand, waarvan de helft met audio, komt het totaal op grofweg 5–10 USD per maand. De kost wordt vrijwel volledig bepaald door het aantal gegenereerde verslagen en audiobestanden. Zet bij Anthropic een **maandelijks uitgavenlimiet** om onverwachte kosten te vermijden.

### 1.6 Beperkingen en aandachtspunten

- De worker is bewust "dom": hij kent geen limiet per gebruiker. Een ingelogde gebruiker kan dus onbeperkt verslagen genereren (kosten!). Een limiet per gebruiker is een mogelijke uitbreiding.
- Wachtwoorden worden gehasht met SHA-256 + pepper (geen bcrypt/argon2). Voldoende voor een intern hulpmiddel, niet voor publieke diensten.
- Het uitspraaklijstje voor Nederlandse audio (`NL_PRONUNCIATIONS` in `index.html`) moet handmatig worden aangevuld als woorden fout worden uitgesproken.
- Azure TTS draait op het gratis F0-niveau en verwerkt daarom twee stukken tegelijk, met automatisch opnieuw proberen bij rate limits. Bij intensief gebruik is het betaalde niveau (S0) aan te raden.

---

### 1.7 Modellen en uitfasering

Controleer regelmatig of de gebruikte modellen niet worden uitgefaseerd (laatste controle: oktober 2026).

| Model | Gebruikt voor | Status |
|---|---|---|
| `claude-sonnet-4-6` (Anthropic) | Verslag | Actief, vroegst mogelijke uitfasering 17 februari 2027. Aanbevolen opvolger: `claude-sonnet-5-5` (actief tot minstens 28 september 2027). Overstappen kan zonder codewijziging door in Cloudflare de variabele `CLAUDE_MODEL` te zetten (Worker → Settings → Variables and Secrets) en daarna het resultaat te testen. |
| Azure Neural-stemmen | Audio | Geen uitfasering bekend. |
| ~~OpenAI `gpt-4o-mini-tts`~~ | ~~Audio~~ | OpenAI schakelt zijn TTS-modellen uit op 6 januari 2027. De app gebruikt OpenAI daarom niet meer. |

Controlebronnen: https://platform.claude.com/docs/en/about-claude/model-deprecations en https://developers.openai.com/api/docs/deprecations.

---

## Deel 2 — Continuïteit: als Gwenn er niet meer is

Doel: IT moet de app kunnen verderzetten, aanpassen of veilig uitschakelen zonder toegang tot Gwenns persoonlijke accounts.

### 2.1 Overzicht van de accounts en afhankelijkheden

| Dienst | Waarvoor | Gekoppeld aan | Risico als account wegvalt |
|---|---|---|---|
| **GitHub** — organisatie `Winsol-Belgie`, repo `meeting-report-generator` | Code + hosting (GitHub Pages) | Organisatie; controleer wie **Owner** is | Laag als er meerdere Owners zijn; hoog als enkel Gwenn Owner is |
| **Cloudflare** | Worker, KV (gebruikers/sessies), secrets | Gwenns account. De URL `meeting-report-generator.gwenn-vanthournout.workers.dev` bevat haar accountnaam | **Hoog.** Zonder toegang kan niets worden aangepast of gedeployd; de worker kan verdwijnen als het account wordt gesloten |
| **Anthropic** (console.anthropic.com) | API-sleutel voor het verslag + betaling | Account/kaart van de aanmaker (controleer) | **Hoog.** Sleutel ingetrokken of kaart geblokkeerd = geen verslagen meer |
| **Microsoft Azure** | Speech-resource (West-Europa, gratis niveau F0) voor Nederlandse audio | **Persoonlijk Microsoft-account** van Gwenn (bewust als proof of concept) | Middelmatig: Nederlandse audio valt weg; resource is niet overdraagbaar zonder migratie |
| **Domeinnaam / DNS** | — | Niet van toepassing: de app gebruikt `github.io` en `workers.dev` | — |

### 2.2 Secrets en configuratie die nergens in de code staan

Deze waarden staan versleuteld in Cloudflare (Workers → `meeting-report-generator` → Settings → Variables and Secrets). Ze kunnen **niet teruggelezen** worden; bij verlies moeten ze opnieuw aangemaakt worden.

| Secret | Inhoud | Opnieuw aanmaken via |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sleutel van Anthropic | console.anthropic.com → API keys |
| `AZURE_SPEECH_KEY` | Sleutel van de Azure Speech-resource | Azure-portal → Speech-resource → Keys and Endpoint |
| `PASSWORD_PEPPER` | Willekeurige tekst waarmee wachtwoorden gehasht worden | Zelf bedenken |

**Belangrijk bij `PASSWORD_PEPPER`:** de opgeslagen wachtwoordhashes zijn ermee berekend. Gaat de pepper verloren of wordt hij gewijzigd, dan werkt **geen enkel wachtwoord** meer. Oplossing: nieuwe pepper zetten en alle gebruikers opnieuw laten aanmaken (zie 2.4, stap 5). Bewaar de pepper daarom in de Winsol-wachtwoordkluis.

Andere configuratie:

- **KV-namespace** `MEETING_KV`, id `358f663d0e0a426c95bd1ca5a2fdb220` (staat in `wrangler.toml`). Bevat de gebruikers en sessies. Gaat de namespace verloren, dan moeten gebruikers opnieuw worden aangemaakt.
- **`WORKER_URL`** in `index.html` (zoek op `WORKER_URL`): verwijst naar de worker. Verhuist de worker naar een ander account, dan verandert deze URL en moet `index.html` aangepast worden.

### 2.3 Mogelijke struikelblokken

1. **Cloudflare-account is persoonlijk.** Zonder inlog (en de 2FA van Gwenn) kan niemand de worker aanpassen, secrets vernieuwen of kosten/limieten bekijken.
2. **API-sleutels hangen aan persoonlijke betaalaccounts.** Wordt de kaart of het account stopgezet, dan stopt de app zonder duidelijke foutmelding voor de gebruiker (generieke fout bij genereren).
3. **Azure-resource op een persoonlijk Microsoft-account.** Niet overdraagbaar; IT moet een nieuwe Speech-resource aanmaken onder een bedrijfsabonnement.
4. **De worker-URL bevat Gwenns naam** (`gwenn-vanthournout.workers.dev`). Bij migratie naar een bedrijfsaccount verandert die en moet `index.html` mee aangepast worden.
5. **Deployen vereist de Wrangler-CLI en een Cloudflare-login.** De GitHub-push werkt de pagina automatisch bij, maar de worker (`worker.js`) wordt **niet** automatisch gedeployed. Wijzigingen aan `worker.js` komen pas live na `npx wrangler deploy`.
6. **Geen back-up van de gebruikers.** De gebruikerslijst staat enkel in KV. Bewaar het Excel-bestand met gebruikers (kolommen USER/PW/ROLE) op een beveiligde plek, niet in de repo.
7. **Nederlandse audio kan op het gratis niveau tegen limieten aanlopen** (F0: 500.000 tekens/maand en lage gelijktijdigheid).
8. **Geen monitoring of alarmering.** Valt een sleutel of limiet weg, dan merkt niemand het tot een gebruiker klaagt.
9. **Gegevensverwerking door derden.** Transcripts bevatten bedrijfsgevoelige informatie en gaan naar Anthropic, OpenAI en Microsoft (zie 2.5).

### 2.4 Stappenplan voor overname door IT

1. **Toegang regelen (liefst nu al).** Voeg minstens één tweede persoon als **Owner** toe aan de GitHub-organisatie. Maak voor Cloudflare en Anthropic een **bedrijfsaccount** (generiek IT-adres, bv. `it@winsol.eu`) en betaal via een bedrijfskaart of factuur. Zet 2FA aan en bewaar herstelcodes in de wachtwoordkluis.
2. **Nieuw Cloudflare-account (of bestaande bedrijfsaccount) gebruiken.**
   - `git clone https://github.com/Winsol-Belgie/meeting-report-generator.git` en `npm install -g wrangler` (of `npx wrangler`).
   - `npx wrangler login`.
   - Nieuwe KV-namespace maken: `npx wrangler kv namespace create MEETING_KV`. Zet de teruggegeven `id` in `wrangler.toml`.
   - Secrets zetten, elk met `npx wrangler secret put <NAAM>`: `ANTHROPIC_API_KEY`, `AZURE_SPEECH_KEY`, `PASSWORD_PEPPER`.
   - Deployen: `npx wrangler deploy`. Noteer de nieuwe worker-URL.
3. **Frontend aanpassen.** Vervang in `index.html` de waarde van `WORKER_URL` door de nieuwe URL. Commit en push; GitHub Pages werkt zichzelf bij.
4. **Nieuwe Azure Speech-resource.** Maak in een bedrijfsabonnement een "Speech"-resource (regio West-Europa). Is de regio anders, pas dan in `worker.js` de URL `https://westeurope.tts.speech.microsoft.com/...` aan. Zet de nieuwe sleutel als `AZURE_SPEECH_KEY`. Overweeg betaald niveau (S0) bij intensief gebruik.
5. **Eerste admin aanmaken.** Er is nog geen gebruiker, dus de eerste moet rechtstreeks in KV. Bereken de hash: `node -e "const c=require('crypto');console.log(c.createHash('sha256').update('WACHTWOORD'+'PEPPER').digest('hex'))"`. Zet daarna het resultaat in KV, met een JSON-bestand `user.json` dat `{"username":"NAAM","passwordHash":"HASH","role":"admin"}` bevat: `npx wrangler kv key put --remote --namespace-id=<ID> "user:NAAM" --path=user.json`. Gebruik `--remote`, anders wordt enkel de lokale testomgeving gevuld. Verdere gebruikers kunnen daarna via de kaart "Gebruikers beheren" in de app worden opgeladen met een Excel.
6. **Testen.** Inloggen, een kort verslag genereren, audio in NL en FR proberen.
7. **Oude toegang intrekken.** Verwijder de oude API-sleutels bij Anthropic en Azure, en sluit/verwijder de oude worker zodra de nieuwe werkt.

### 2.5 Privacy en veiligheid

- **Verwerkers.** Transcripts verlaten de browser en gaan naar Anthropic en Microsoft. Laat de juridische dienst/DPO nagaan of er een verwerkersovereenkomst is, of de contractvoorwaarden voor API-gebruik volstaan, en of het gebruik past binnen het Winsol-beleid voor vertrouwelijke gegevens.
- **Geen opslag door de app.** De footer in de app vermeldt dat niets wordt bewaard. Dat klopt voor onze eigen code (alleen gebruikers en sessies staan in KV), maar niet voor de leveranciers: kijk hun bewaartermijnen na.
- **Repo-inhoud.** De repo en de pagina op GitHub Pages zijn mogelijk publiek toegankelijk (controleer de zichtbaarheid van de repo). `people.json` bevat namen en functies van medewerkers en `index.html` bevat de worker-URL. Zet daarom **geen wachtwoorden, sleutels of gebruikerslijsten** in de repo.
- **Beperk kosten.** Stel bij Anthropic een maandelijks limiet in en laat meldingen naar een gedeeld adres gaan.

### 2.6 Aanbevolen verbeteringen voor continuïteit

1. Eigenaarschap van alle accounts verhuizen naar Winsol-IT (Cloudflare, Anthropic, Azure) en minstens twee beheerders aanduiden.
2. Worker-URL loskoppelen van Gwenns naam (eigen Cloudflare-account of eigen subdomein).
3. Azure-resource onder een bedrijfsabonnement plaatsen.
4. Secrets en de pepper bewaren in de wachtwoordkluis van IT.
5. Automatische deploy van de worker via GitHub Actions (nu manueel met Wrangler).
6. Een eenvoudige limiet per gebruiker en een kostenmelding toevoegen.
