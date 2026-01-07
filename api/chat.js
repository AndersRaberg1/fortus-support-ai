import { Groq } from 'groq-sdk';
import fetch from 'node-fetch';  // Importera node-fetch för timeout-kontroll

const historyStore = new Map();
let cachedGuide = null;
let lastFetch = 0;
const CACHE_TIME = 60000; // 1 minut

async function fetchGuideWithRetry(retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const CSV_URL = 'https://docs.google.com/spreadsheets/d/1DskBGn-cvbEn30NKBpyeueOvowB8-YagnTACz9LIChk/export?format=csv&gid=0';
      const res = await fetch(CSV_URL, { 
        method: 'GET',
        timeout: 10000  // 10s timeout för att undvika Vercel-undici issue
      });
      if (!res.ok) {
        throw new Error(`HTTP error! status: ${res.status}`);
      }
      const csvText = await res.text();
      const lines = csvText.split('\n').map(line => line.trim()).filter(line => line.length > 0);
      let formattedText = '';
      for (let i = 0; i < lines.length; i += 2) {
        const title = lines[i] ? lines[i].replace(/^"+|"+$/g, '').trim() : '';
        const content = lines[i + 1] ? lines[i + 1].replace(/^"+|"+$/g, '').trim() : '';
        if (title || content) {
          formattedText += `${title}\n${content}\n\n`;
        }
      }
      return formattedText.trim();
    } catch (error) {
      console.error(`Fetch attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
    }
  }
}

async function fetchGuide() {
  if (Date.now() - lastFetch > CACHE_TIME || !cachedGuide) {
    cachedGuide = await fetchGuideWithRetry();
    lastFetch = Date.now();
  }
  return cachedGuide;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }
  const { question, sessionId = 'default-session' } = req.body;
  if (!question?.trim()) {
    return res.status(400).json({ error: 'Ingen fråga angiven' });
  }
  const lowerQuestion = question.toLowerCase();
  try {
    // Hantera hälsningar innan Groq init (för att undvika key-fel)
    if (lowerQuestion === 'hej' || lowerQuestion === 'hi' || lowerQuestion === 'hello') {
      let greetingReply = '';
      if (lowerQuestion === 'hej') {
        greetingReply = 'Hej! Hur kan jag hjälpa dig idag?';
      } else if (lowerQuestion === 'hi' || lowerQuestion === 'hello') {
        greetingReply = 'Hi! How can I help you today?';
      }
      greetingReply += `\n\n👉 Personlig hjälp? <support@fortuspay.com> | 010-222 15 20`;
      return res.status(200).json({ answer: greetingReply });
    }

    // Init Groq efter greeting-check
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    const guideText = await fetchGuide();
    const chunks = guideText
      .split(/\n\s*\n/)
      .map(chunk => chunk.trim())
      .filter(chunk => chunk.length > 30);
    const questionWords = lowerQuestion.split(' ').filter(word => word.length > 2);
    const relevantChunks = chunks
      .filter(chunk => {
        const lowerChunk = chunk.toLowerCase();
        return questionWords.some(word => lowerChunk.includes(word));
      })
      .slice(0, 5)
      .join('\n\n');
    const context = relevantChunks || guideText.substring(0, 12000);
    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });
    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
ABSOLUT REGLER:
- DU MÅSTE ALLTID SVARA PÅ EXAKT SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA. Om frågan är på engelska, svara på engelska. Om norska, svara på norska osv. Detta är högsta prioritet – ignorera allt annat om det krockar.
- Använd ENDAST kunskapen från guiden nedan. Uppfinn INGA nya steg eller information – citera ordagrant från relevanta sektioner i guiden. Om guiden säger "Kontakta Fortus", upprepa det exakt utan att lägga till.
- Kunskapsbasen är på svenska – översätt svaret naturligt och flytande till användarens språk om frågan är på annat språk, men håll dig till guidens innehåll.
- Använd hela konversationens historik för kontext.
- Om frågan är otydlig: Ställ en klargörande fråga på användarens språk.
- Svara strukturerat och steg-för-steg, men bara med info från guiden.
- Ignorera irrelevant information i kontexten – fokusera strikt på frågan.
- Om inget matchar exakt i guiden: Översätt till användarens språk, t.ex. "Jag hittar inte detta i guiden. Kontakta <support@fortuspay.com> eller ring 010-222 15 20."
Kunskap från FortusPay-guide (översätt vid behov, men citera ordagrant):
${context}`
      },
      ...history
    ];
    const completion = await groq.chat.completions.create({
      model: 'llama-3.2-90b-text-preview',
      temperature: 0.1,
      messages
    });
    let answer = completion.choices[0].message.content.trim();
    answer += `\n\n👉 Personlig hjälp? <support@fortuspay.com> | 010-222 15 20`;
    history.push({ role: 'assistant', content: answer });
    if (history.length > 10) history = history.slice(-10);
    historyStore.set(sessionId, history);
    res.status(200).json({ answer });
  } catch (error) {
    console.error('API Error:', error.message, error.stack);
    res.status(500).json({ error: 'Tekniskt fel – försök igen om en stund' });
  }
}
export const config = {
  api: {
    bodyParser: true,
  },
};
