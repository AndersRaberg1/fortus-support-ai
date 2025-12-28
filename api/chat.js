import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pub?output=csv';

let cachedCSV = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter

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

  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Ingen fråga' });

  try {
    const csvText = await fetchCSV();

    const chunks = csvText.split(/\n\s*\n/).filter(c => c.trim().length > 30);

    const lowerQuestion = question.toLowerCase();
    const relevant = chunks
      .filter(chunk => chunk.toLowerCase().includes(lowerQuestion))
      .slice(0, 8)
      .join('\n\n');

    const context = relevant || csvText.substring(0, 15000);

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `Du är FortusPay Support-AI – vänlig och professionell.

REGLER:
- Svara ENDAST baserat på kunskapen nedan.
- Om frågan inte täcks: "Jag hittar inte detta i guiden. Kontakta support@fortuspay.com eller ring 010-222 15 20."
- Strukturerat, steg-för-steg, på svenska.

Kunskap:
${context}`
        },
        { role: 'user', content: question }
      ]
    });

    let answer = completion.choices[0].message.content.trim();
    answer += `\n\n👉 Personlig hjälp? support@fortuspay.com | 010-222 15 20`;

    res.status(200).json({ answer });
  } catch (error) {
    res.status(500).json({ error: 'Tekniskt fel' });
  }
}

export const config = { api: { bodyParser: true } };
