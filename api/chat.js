import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedChunks = null;
let lastFetch = 0;
const CACHE_TIME = 1800000; // 30 minuter för stabilitet

const historyStore = new Map();

// Enkel stemming för bättre matchning på svenska/engelska
function simpleStem(word) {
  return word.replace(/(er|ar|or|en|et|a|e|s|t|ing|ed)$/i, '').trim();
}

// Uppdaterad keyword-mappning baserat på exakta titlar från din Google Sheet (hämtad färskt)
const keywordMap = {
  faktura: ['Anslut Faktura'],
  swish: ['Anslut Swish'],
  dagsavslut: ['Skapa Dagsavslut', 'Fortus POS | Dagsavslut och Öppning av Kassa'],
  retur: ['Skapa Retur'],
  kvitto: ['Hämta kopia på kvitto', 'Fortus Web POS | Lägg till / Redigera kvittotexter och bild'],
  felsökning: ['Felsökning'],
  bild: ['Fortus Web POS | Lägg till / Redigera kvittotexter och bild'],
  kontrollenhet: ['Fortus Web POS | Aktivera Kontrollenhet'],
  stand: ['Hårdvara till Fortus Android POS | Montera Single Stand'],
  montera: ['Hårdvara till Fortus Android POS | Montera Single Stand'],
  skärm: ['Hårdvara till Fortus POS | Koppla Extra Skärm'],
  inställningar: ['Fortus POS | Inställningar i Fortus POS']
};

async function fetchAndChunkGuide() {
  const now = Date.now();
  if (now - lastFetch > CACHE_TIME || !cachedChunks) {
    const PUBHTML_URL =
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';

    try {
      const res = await fetch(PUBHTML_URL);
      if (!res.ok) throw new Error('Kunde inte hämta guide');

      const html = await res.text();
      const cellMatches = html.match(/<td[^>]*>(.*?)<\/td>/g) || [];
      const cells = cellMatches
        .map(match => match
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .trim()
        )
        .filter(text => text.length > 0);

      const chunks = [];
      for (let i = 0; i < cells.length; i += 2) {
        const title = cells[i]?.trim() || 'Okänd sektion';
        const content = cells[i + 1]?.trim() || '';
        chunks.push({
          title,
          content,
          full: `### ${title}\n${content}`
        });
      }

      cachedChunks = chunks;
      lastFetch = now;
    } catch (err) {
      console.error('Guide fetch error:', err);
      if (!cachedChunks) throw err; // Använd gammal cache om möjligt
    }
  }
  return cachedChunks;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { question, sessionId = 'default-session' } = req.body;

  if (!question?.trim()) {
    return res.status(400).json({ error: 'Ingen fråga angiven' });
  }

  try {
    const chunks = await fetchAndChunkGuide();

    const lowerQuestion = question.toLowerCase().replace(/[?.!]/g, '');
    const questionWords = lowerQuestion.split(' ').filter(w => w.length > 2);
    const stemmedWords = questionWords.map(simpleStem).filter(w => w.length > 2);

    // Samla relevanta chunks: Först keywordMap, sen allmän sökning
    let relevantChunks = [];
    for (const word of [...questionWords, ...stemmedWords]) {
      if (keywordMap[word]) {
        const mappedTitles = keywordMap[word];
        const matched = chunks.filter(c => mappedTitles.includes(c.title));
        relevantChunks.push(...matched);
      }
    }

    if (relevantChunks.length < 3) {
      const generalMatches = chunks.filter(chunk => {
        const lowerFull = (chunk.title + ' ' + chunk.content).toLowerCase();
        return [...questionWords, ...stemmedWords].some(word => lowerFull.includes(word));
      });
      relevantChunks.push(...generalMatches);
    }

    relevantChunks = [...new Set(relevantChunks)].slice(0, 8); // Unika, max 8

    const context = relevantChunks.length > 0
      ? relevantChunks.map(c => c.full).join('\n\n')
      : 'Ingen matchande sektion hittades.';

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – extremt hjälpsam, vänlig och professionell. Svara alltid på exakt samma språk som användarens fråga. Var maximalt hjälpsam: ställ vänliga motfrågor om frågan är otydlig eller du behöver mer info för att ge rätt svar (t.ex. "Vilken enhet använder du?"). Om hälsning: Svara vänligt och fråga hur du kan hjälpa.

Om relevanta sektioner finns i guiden:
- Börja med "Enligt guiden i sektionen [Exakt titel]:"
- Citera innehållet ordagrant (bevara formatering, radbrytningar).
- Lista flera sektioner om de passar.
- Lägg aldrig till eller ändra info – håll dig till guiden.

Om ingen träff: "Jag hittar inte exakt detta i guiden. Kan du berätta mer så jag kan hjälpa bättre? Alternativt kontakta support@fortuspay.com eller ring 010-222 15 20."

Guide-sektioner:
${context}`
      },
      ...history.slice(-10)
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.2, // Låg för exakta svar, men naturlig ton
      max_tokens: 1000,
      messages
    });

    let answer = completion.choices[0].message.content.trim();

    answer += `\n\n👉 Behöver du mer hjälp? support@fortuspay.com | 010-222 15 20`;

    history.push({ role: 'assistant', content: answer });
    if (history.length > 12) history = history.slice(-12);
    historyStore.set(sessionId, history);

    res.status(200).json({ answer });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Tekniskt fel – prova igen om en stund' });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
