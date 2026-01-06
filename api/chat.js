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

    // Extrahera ord längre än 2 tecken
    const questionWords = lowerQuestion
      .split(' ')
      .filter(word => word.length > 2);

    // Hitta och ranka relevanta chunks
    let relevantChunks = chunks
      .map(chunk => {
        const lowerFull = (chunk.title + ' ' + chunk.content).toLowerCase();
        const matches = questionWords.filter(word => lowerFull.includes(word));
        return { chunk, score: matches.length };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.chunk)
      .slice(0, 4); // Max 4 sektioner

    // Om ingen träff alls – ingen context (prompten hanterar fallback)
    const context = relevantChunks.length > 0
      ? relevantChunks.map(c => c.full).join('\n\n')
      : '';

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
ABSOLUT REGLER (FÖLJ DEM EXAKT):
- SVARA ALLTID PÅ SVENSKA.
- Om det finns relevanta sektioner i context: 
  - Hitta den/de mest relevanta (baserat på titel och innehåll).
  - Börja med "Enligt guiden i sektionen [Exakt titel]:" för varje.
  - Citera sedan innehållet ordagrant (bevara radbrytningar, punkter och formatering).
  - Om flera relevanta sektioner: Lista dem en efter en.
- Lägg inte till egna steg, förklaringar eller råd utanför guiden.
- Om ingen context eller osäker: Svara ENDAST "Enligt guiden finns ingen exakt info om detta – kontakta support@fortuspay.com eller ring 010-222 15 20."
Relevant guide-sektioner:
${context || 'Ingen relevant sektion hittades.'}`
      },
      ...history.slice(-8)
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.0,
      max_tokens: 800,
      messages
    });

    let answer = completion.choices[0].message.content.trim();

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
