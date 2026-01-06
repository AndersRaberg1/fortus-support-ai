import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedChunks = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter

const historyStore = new Map();

async function fetchAndChunkGuide() {
  if (Date.now() - lastFetch > CACHE_TIME || !cachedChunks) {
    const PUBHTML_URL =
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';

    const res = await fetch(PUBHTML_URL);
    if (!res.ok) throw new Error('Kunde inte hämta guide från Google Sheets');

    const html = await res.text();

    // Extrahera celler och ersätt <br> med \n för att behålla formatering
    const cellMatches = html.match(/<td[^>]*>(.*?)<\/td>/g) || [];
    const cells = cellMatches
      .map(match => match
        .replace(/<br\s*\/?>/gi, '\n')  // Behåll radbrytningar
        .replace(/<[^>]+>/g, '')
        .trim()
      )
      .filter(text => text.length > 0);

    const chunks = [];
    for (let i = 0; i < cells.length; i += 2) {
      const title = cells[i] || 'Okänd sektion';
      const content = cells[i + 1] || '';
      if (title || content) {
        chunks.push({
          title: title.trim(),
          content: content.trim(),
          full: `### ${title.trim()}\n${content.trim()}`
        });
      }
    }

    cachedChunks = chunks;
    lastFetch = Date.now();
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

    // Extrahera nyckelord (filtrera bort stoppord)
    const stopWords = ['hur', 'jag', 'gör', 'det', 'på', 'i', 'till', 'med', 'och', 'en', 'att', 'för', 'av'];
    const questionWords = lowerQuestion
      .split(' ')
      .filter(word => word.length > 2 && !stopWords.includes(word));

    // 1. Prioritet: Träff i titel (minst 1 nyckelord)
    let relevantChunks = chunks
      .filter(chunk => {
        const lowerTitle = chunk.title.toLowerCase();
        return questionWords.some(word => lowerTitle.includes(word));
      })
      .sort((a, b) => {
        const scoreA = questionWords.filter(w => a.title.toLowerCase().includes(w)).length;
        const scoreB = questionWords.filter(w => b.title.toLowerCase().includes(w)).length;
        return scoreB - scoreA;
      });

    // 2. Om ingen titelträff: Träff i innehåll
    if (relevantChunks.length === 0) {
      relevantChunks = chunks
        .filter(chunk => {
          const lowerContent = chunk.content.toLowerCase();
          return questionWords.some(word => lowerContent.includes(word));
        })
        .sort((a, b) => {
          const scoreA = questionWords.filter(w => (a.title + a.content).toLowerCase().includes(w)).length;
          const scoreB = questionWords.filter(w => (b.title + b.content).toLowerCase().includes(w)).length;
          return scoreB - scoreA;
        });
    }

    // 3. Fallback: Specifika nyckelord
    if (relevantChunks.length === 0) {
      const fallbackKeywords = ['swish', 'dagsavslut', 'retur', 'kvitto', 'bild', 'stand', 'montera', 'kontrollenhet', 'fortnox', 'faktura'];
      relevantChunks = chunks.filter(chunk => {
        const lowerFull = (chunk.title + chunk.content).toLowerCase();
        return fallbackKeywords.some(kw => lowerFull.includes(kw) && lowerQuestion.includes(kw));
      });
    }

    // Ta topp 3 (för att täcka relaterade sektioner om flera)
    relevantChunks = relevantChunks.slice(0, 3);

    const context = relevantChunks.map(c => c.full).join('\n\n');

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
ABSOLUT REGLER (FÖLJ DEM EXAKT):
- SVARA ALLTID PÅ SVENSKA (användarens fråga är på svenska).
- HITTA DEN MEST RELEVANTA SEKTIONEN I CONTEXT (baserat på titel).
- BÖRJA SVARET MED "Enligt guiden i sektionen [Exakt titel]:"
- CITERA SEDAN INNEHÅLLET ORDAGRANT (bevara radbrytningar och formatering, lägg inte till eller ändra steg).
- Om flera relevanta sektioner: Lista dem en i taget med titel + exakt citat.
- LÄGG INTE TILL EGNA STEG, FÖRKLARINGAR ELLER RÅD UTANFÖR GUIDEN.
- Om ingen relevant sektion eller osäker: Svara ENDAST "Enligt guiden finns ingen exakt info om detta – kontakta support@fortuspay.com eller ring 010-222 15 20."
Relevant guide-sektioner:
${context || 'Ingen relevant sektion hittades.'}`
      },
      ...history.slice(-8) // Behåll lite historik
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.0, // Noll för att minimera hallucination
      max_tokens: 800,
      messages
    });

    let answer = completion.choices[0].message.content.trim();

    // Lägg till standardfot
    answer += `\n\n👉 Personlig hjälp? support@fortuspay.com | 010-222 15 20`;

    history.push({ role: 'assistant', content: answer });
    if (history.length > 10) history = history.slice(-10);
    historyStore.set(sessionId, history);

    res.status(200).json({ answer });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Tekniskt fel – försök igen om en stund' });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
