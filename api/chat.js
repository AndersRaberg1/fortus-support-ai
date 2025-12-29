import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pub?output=csv';

let cachedCSV = null;
let lastFetch = 0;
const CACHE_TIME = 300000;

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
    const chunks = csvText.split(/\n\s*\n/).filter(c => c.trim().length > 30);
    const lowerQuestion = question.toLowerCase();
    const relevant = chunks
      .filter(chunk => chunk.toLowerCase().includes(lowerQuestion))
      .slice(0, 6)
      .join('\n\n');
    const context = relevant || csvText.substring(0, 12000);

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
VIKTIGA REGLER:
- Detektera automatiskt språk i frågan och svara alltid på samma språk som användaren (t.ex. engelska, norska, danska, tyska osv.).
- Använd hela konversationens historik för kontext.
- Om frågan är otydlig: Ställ en klargörande fråga.
- Svara strukturerat och steg-för-steg.
- Om inget matchar i guiden: "Jag hittar inte detta i guiden. Kontakta support@fortuspay.com eller ring 010-222 15 20."

Kunskap från FortusPay-guide (på svenska, översätt vid behov):
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
    res.status(500).json({ error: 'Tekniskt fel' });
  }
}

export const config = { api: { bodyParser: true } };
