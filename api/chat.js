import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pub?output=csv';

let cachedCSV = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter

// In-memory historik
const historyStore = new Map();

async function fetchCSV() {
  if (Date.now() - lastFetch > CACHE_TIME || !cachedCSV) {
    const res = await fetch(CSV_URL);
    if (!res.ok) throw new Error('Kunde inte hämta guide');
    cachedCSV = await res.text();
    lastFetch = Date.now();
  }
  return cachedCSV;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { question, sessionId = 'default-session' } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Ingen fråga' });

  try {
    const csvText = await fetchCSV();

    // Bättre chunkning: Dela på rubriker som "Anslut XXX" eller "Steg för steg"
    const chunks = csvText.split(/([A-Z][a-z]+ [A-Z][a-z]+För att|Steg för steg)/g).filter(c => c.trim().length > 30);

    const lowerQuestion = question.toLowerCase();
    const relevant = chunks
      .filter(chunk => chunk.toLowerCase().includes(lowerQuestion))
      .slice(0, 5) // Minska för mer fokus
      .join('\n\n');

    const context = relevant || csvText.substring(0, 10000);

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.

STRIKTA REGLER:
- SVARA ALLTID PÅ SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA (t.ex. engelska om frågan är på engelska, norska om norska, danska om danska osv.). Detta är högsta prioritet.
- Kunskapsbasen är på svenska – översätt svaret naturligt och korrekt till användarens språk.
- Använd hela konversationens historik för kontext.
- Om frågan är otydlig: Ställ en klargörande fråga på användarens språk.
- Svara strukturerat och steg-för-steg.
- Ignorera irrelevant info i kontexten – fokusera på frågan.
- Om inget matchar: Översätt fallback-meddelandet till användarens språk, t.ex. "I can't find this in the guide. Contact support@fortuspay.com or call 010-222 15 20."

Kunskap från FortusPay-guide (översätt vid behov):
${context}`
      },
      ...history
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      messages
    });

    let answer = completion.choices[0].message.content.trim();
    answer += `\n\n👉 Personlig hjälp? support@fortuspay.com | 010-222 15 20`;

    history.push({ role: 'assistant', content: answer });
    history = history.slice(-10);
    historyStore.set(sessionId, history);

    res.status(200).json({ answer });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Tekniskt fel – försök igen om en stund' });
  }
}

export const config = { api: { bodyParser: true } };
