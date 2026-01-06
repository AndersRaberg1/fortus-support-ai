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
    } catch (error) {
      console.error('Fetch error:', error);
      if (cachedCSV) return cachedCSV; // Fallback till gammal cache
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
    let relevant = chunks.filter(chunk => chunk.toLowerCase().includes(lowerQuestion)).slice(0, 8).join('\n\n');
    const context = relevant || csvText.substring(0, 15000);

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – extremt hjälpsam, professionell och noggrann.
STRIKTA REGLER – FÖLJ DEM ALLTID:
- Om du saknar viktig information för att ge ett korrekt och komplett svar, STÄLL EN KLARGÖRANDE FRÅGA istället för att gissa eller ge ofullständigt svar.
  Exempel på när du ska fråga:
  - "Terminal" eller "betalterminal" → "Vilken modell av betalterminal använder du (t.ex. Verifone, Ingenico, Fortus Smart)?"
  - "Swish" eller "anslut Swish" → "Är det för webshop, POS eller annan kanal?"
  - "Dagsavslut" → "Vilken dag eller period gäller det?"
  - "Kvittobild" → "Vill du lägga till bild i toppen eller foten av kvittot?"
  - "Fortnox" → "Vilken del av integrationen behöver du hjälp med?"
  - Allmänna fel → "Kan du beskriva exakt vad som händer och vilket felmeddelande du ser?"
- Använd hela konversationens historik för att minnas tidigare svar och undvika att fråga samma sak igen.
- SVARA ALLTID PÅ SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA (engelska → engelska, svenska → svenska osv.).
- Översätt svar naturligt från kunskapsbasen (som är på svenska).
- Svara strukturerat, kort och steg-för-steg.
- Om inget matchar: "Jag hittar inte detta i guiden. Kontakta <support@fortuspay.com> eller ring 010-222 15 20."
Kunskap från FortusPay-guide (översätt vid behov):
${context}`
      },
      ...history
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
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
