import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedChunks = null;
let lastFetch = 0;
const CACHE_TIME = 1800000; // 30 minuter för extra stabilitet (ändra vid behov)

const historyStore = new Map();

// Enkel stemming för svenska + engelska
function simpleStem(word) {
  return word.replace(/(er|ar|or|en|et|a|e|s|t|ing|ed)$/i, '').trim();
}

async function fetchAndChunkGuide() {
  const now = Date.now();
  if (now - lastFetch > CACHE_TIME || !cachedChunks) {
    const PUBHTML_URL =
      'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';

    try {
      const res = await fetch(PUBHTML_URL, { timeout: 10000 });
      if (!res.ok) throw new Error('Fetch misslyckades');

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
      lastFetch = now;
    } catch (err) {
      console.error('Guide fetch error:', err);
      // Använd gammal cache om tillgänglig
      if (!cachedChunks) throw err;
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
    let questionWords = lowerQuestion.split(' ').filter(word => word.length > 2);
    const stemmedWords = questionWords.map(simpleStem).filter(w => w.length > 2);
    const searchWords = [...new Set([...questionWords, ...stemmedWords])];

    // Bred ranking – inkludera även lösa träffar
    const relevantChunks = chunks
      .map(chunk => {
        const lowerFull = (chunk.title + ' ' + chunk.content).toLowerCase();
        const matches = searchWords.filter(word => lowerFull.includes(word));
        return { chunk, score: matches.length || (searchWords.some(w => lowerFull.includes(w.slice(0, -1))) ? 0.5 : 0) };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(item => item.chunk)
      .slice(0, 8); // Mer kontext för bättre svar

    // Extra fallback för vanliga ämnen även vid låg score
    const commonKeywords = ['swish', 'dagsavslut', 'retur', 'kvitto', 'bild', 'stand', 'fortnox', 'kontrollenhet'];
    if (relevantChunks.length < 3 && commonKeywords.some(kw => lowerQuestion.includes(kw))) {
      const extra = chunks.filter(c => commonKeywords.some(kw => (c.title + c.content).toLowerCase().includes(kw)));
      relevantChunks.push(...extra);
    }

    const context = relevantChunks.length > 0
      ? [...new Set(relevantChunks.map(c => c.full))].join('\n\n') // Unika
      : 'Begränsad guide tillgänglig just nu.';

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – extremt hjälpsam, vänlig och professionell.
VIKTIGA REGLER:
- SVARA ALLTID PÅ EXAKT SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA (upptäck automatiskt).
- Om hälsning (hej/hi/hello/hejja osv.): Svara vänligt "Hej! Hur kan jag hjälpa dig med FortusPay idag?" eller motsvarande på språket.
- Använd guiden för att förklara steg-för-steg, sammanfatta och guida.
- Översätt naturligt till användarens språk.
- Var maximalt hjälpsam: Ställ vänliga motfrågor om något är otydligt (t.ex. "Menar du i terminalen eller Web POS?").
- Om låg träff: Fråga efter mer detaljer istället för att ge upp.
- Avsluta med kontaktinfo om relevant.

Guide-innehåll:
${context}`
      },
      ...history.slice(-10)
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.5, // Naturlig och hjälpsam ton
      max_tokens: 1000,
      messages
    });

    let answer = completion.choices[0].message.content.trim();

    if (!answer.includes('support@fortuspay.com') && !answer.includes('010-222 15 20')) {
      answer += `\n\n👉 Behöver du mer hjälp? support@fortuspay.com | 010-222 15 20`;
    }

    history.push({ role: 'assistant', content: answer });
    if (history.length > 12) history = history.slice(-12);
    historyStore.set(sessionId, history);

    res.status(200).json({ answer });
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({ error: 'Tekniskt fel just nu – prova igen om en stund eller kontakta support direkt!' });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
