import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedCSV = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter

const historyStore = new Map();

async function fetchCSV() {
  const now = Date.now();
  if (now - lastFetch > CACHE_TIME || !cachedCSV) {
    const PUBHTML_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';

    try {
      const res = await fetch(PUBHTML_URL);
      if (!res.ok) throw new Error('Kunde inte hämta guide');

      const html = await res.text();
      const cellMatches = html.match(/<td[^>]*>(.*?)<\/td>/g) || [];
      const lines = cellMatches
        .map(match => match.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim())
        .filter(text => text.length > 0);

      let formattedText = '';
      for (let i = 0; i < lines.length; i += 2) {
        const title = lines[i] || '';
        const content = lines[i + 1] || '';
        if (title || content) {
          formattedText += `${title}\n${content}\n\n`;
        }
      }

      cachedCSV = formattedText.trim();
      lastFetch = now;
      return cachedCSV;
    } catch (error) {
      console.error('Fetch error:', error);
      if (cachedCSV) return cachedCSV;
      throw error;
    }
  }
  return cachedCSV;
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
    const csvText = await fetchCSV();
    const chunks = csvText.split(/\n\s*\n/).map(chunk => chunk.trim()).filter(chunk => chunk.length > 30);

    const lowerQuestion = question.toLowerCase();
    const questionWords = lowerQuestion.split(' ').filter(word => word.length > 2);
    let relevant = chunks.filter(chunk => {
      const lowerChunk = chunk.toLowerCase();
      return questionWords.some(word => lowerChunk.includes(word));
    }).slice(0, 8).join('\n\n');
    const context = relevant || csvText.substring(0, 15000);

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – extremt hjälpsam, professionell och noggrann.
STRIKTA REGLER:
- SVARA ALLTID PÅ SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA.
- Om relevant info finns: Börja med "Enligt guiden i sektionen [Titel]:" och citera innehållet ORDAGRANT (bevara steg, formatering, länkar). Lägg inte till eller ändra något.
- Ställ motfrågor ENDAST om otydligt (t.ex. modell, kanal) – annars ge direkt svar från guiden.
- Använd historik för att minnas.
- Om inget matchar: "Jag hittar inte detta i guiden. Kontakta <support@fortuspay.com> eller ring 010-222 15 20."
Kunskap från FortusPay-guide:
${context}`
      },
      ...history
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1, // Låg för att minimera hallucinationer
      messages,
      max_tokens: 800
    });

    let answer = completion.choices[0].message.content.trim();
    answer += `\n\n👉 Personlig hjälp? <support@fortuspay.com> | 010-222 15 20`;

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
