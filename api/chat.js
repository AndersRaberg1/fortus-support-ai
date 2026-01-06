import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedChunks = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter

const historyStore = new Map();

// Enkel stemming för svenska (och delvis engelska)
function simpleStem(word) {
  return word.replace(/(er|ar|or|en|et|a|e|s|t|ing|ed)$/i, '').trim();
}

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
    let questionWords = lowerQuestion.split(' ').filter(word => word.length > 2);
    const stemmedWords = questionWords.map(simpleStem).filter(w => w.length > 2);
    const searchWords = [...new Set([...questionWords, ...stemmedWords])];

    // Ranka chunks
    const relevantChunks = chunks
      .map(chunk => {
        const lowerFull = (chunk.title + ' ' + chunk.content).toLowerCase();
        const matches = searchWords.filter(word => lowerFull.includes(word));
        return { chunk, score: matches.length };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.chunk)
      .slice(0, 6); // Lite fler för bättre kontext

    const context = relevantChunks.length > 0
      ? relevantChunks.map(c => c.full).join('\n\n')
      : 'Ingen direkt matchande sektion.';

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – extremt hjälpsam, vänlig och professionell.
VIKTIGA REGLER (följ dem alltid):
- SVARA ALLTID PÅ EXAKT SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA (svenska, engelska, norska osv.). Detta är högsta prioritet.
- Om frågan är en hälsning (hej/hi/hello osv.): Svara vänligt med en välkomstfras på samma språk och fråga hur du kan hjälpa.
- Använd guiden som kunskapsbas. Förklara, sammanfatta och guida steg-för-steg baserat på innehållet.
- Översätt guide-innehåll naturligt till användarens språk om det behövs.
- Var maximalt hjälpsam: Om frågan är otydlig eller du behöver mer info → ställ en eller flera vänliga motfrågor för att kunna ge rätt svar.
- Om ingen bra match i guiden: Säg "Jag hittar inte exakt detta i guiden just nu. Kan du berätta mer om vad du försöker göra? Alternativt kan du kontakta support@fortuspay.com eller ringa 010-222 15 20 för personlig hjälp."
- Avsluta alltid med kontaktinfo om det känns relevant.

Relevant guide-innehåll:
${context}`
      },
      ...history.slice(-10)
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.4, // Naturligare och hjälpsammare ton
      max_tokens: 1000,
      messages
    });

    let answer = completion.choices[0].message.content.trim();

    // Lägg till standardfot bara om det inte redan finns
   
