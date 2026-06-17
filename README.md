# Werkplaats Assistent PWA

Mobiel prototype voor monteurs. De app werkt als PWA: open de URL op een iPhone in Safari en kies **Zet op beginscherm**.

## Functies

- Kentekenlookup via RDW Open Data
- Klachtomschrijving, kilometerstand en foutcode
- Foto maken of uploaden vanaf mobiel
- Eerste diagnose/checklist op basis van ingevulde gegevens
- PWA-installatie met manifest en service worker

## Lokaal testen

```bash
python3 -m http.server 4173
```

Open daarna:

```text
http://localhost:4173/monteurs-assistent-pwa/
```

Voor installatie op een iPhone moet de app via HTTPS beschikbaar zijn, bijvoorbeeld via GitHub Pages of de VPS.

## Volgende stap

De huidige diagnose is bewust regelgebaseerd. Voor echte AI-diagnose is een server-side koppeling nodig, zodat API-sleutels niet in de browser terechtkomen.
