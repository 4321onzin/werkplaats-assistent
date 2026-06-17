# Werkplaats Assistent PWA

Mobiel prototype voor monteurs. De app werkt als PWA: open de URL op een iPhone in Safari en kies **Zet op beginscherm**.

## Functies

- Kentekenlookup via RDW Open Data
- Klachtomschrijving, kilometerstand en foutcode
- Foto maken of uploaden vanaf mobiel
- AI-advies via een server-side OpenAI-koppeling
- 4-cijferige toegangscode voor AI-verzoeken
- Fallback-checklist als de AI-backend niet bereikbaar is
- PWA-installatie met manifest en service worker

## Lokaal testen

```bash
npm start
```

Open daarna:

```text
http://localhost:4173/
```

Voor echte AI zet je een API-key in de serveromgeving:

OPENAI_API_KEY=... WORKSHOP_ACCESS_CODE=1234 npm start

De backend kan ook OpenRouter gebruiken als OPENROUTER_API_KEY aanwezig is:

OPENROUTER_API_KEY=... WORKSHOP_ACCESS_CODE=1234 npm start

Zonder API-key kun je de flow testen met mockadvies:

WORKSHOP_AI_MOCK=1 WORKSHOP_ACCESS_CODE=1234 npm start

Voor installatie op een iPhone moet de app via HTTPS beschikbaar zijn, bijvoorbeeld via GitHub Pages plus aparte API-backend, of via de VPS.
