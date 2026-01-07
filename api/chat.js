import { Groq } from 'groq-sdk';
 
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
 
let cachedGuide = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter (ändra till 60000 för snabbare realtid)
 
const historyStore = new Map();
 
async function fetchGuide() {
  if (Date.now() - lastFetch > CACHE_TIME || !cachedGuide) {
    const PUBHTML_URL = '<https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml>';
   
    const res = await fetch(PUBHTML_URL);
    if (!res.ok) throw new Error('Kunde inte hämta guide från Google Sheets');
   
    const html = await res.text();
 
    // Robust extrahering med regex (funkar perfekt i serverless-miljö)
    const cellMatches = html.match(/<td[^>]*>(.*?)</td>/g) || [];
    const lines = cellMatches
      .map(match => match.replace(/<[^>]+>/g, '').trim())
      .filter(text => text.length > 0);
 
    let formattedText = '';
    for (let i = 0; i < lines.length; i += 2) {
      const title = lines[i] || '';
      const content = lines[i + 1] || '';
      if (title || content) {
        formattedText += ${title}\n${content}\n\n;
      }
    }
 
    cachedGuide = formattedText.trim();
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
 
  try {
    const guideText = await fetchGuide();
 
    const chunks = guideText
      .split(/\n\s*\n/)
      .map(chunk => chunk.trim())
      .filter(chunk => chunk.length > 30);
 
    const lowerQuestion = question.toLowerCase();
 
    const relevantChunks = chunks
      .filter(chunk => chunk.toLowerCase().includes(lowerQuestion))
      .slice(0, 5)
      .join('\n\n');
 
    const context = relevantChunks || guideText.substring(0, 10000);
 
    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });
 
    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
ABSOLUT REGLER:

DU MÅSTE ALLTID SVARA PÅ EXAKT SAMMA SPRÅK SOM ANVÄNDARENS FRÅGA. Om frågan är på engelska, svara på engelska. Om norska, svara på norska osv. Detta är högsta prioritet – ignorera allt annat om det krockar.
Kunskapsbasen är på svenska – översätt svaret naturligt och flytande till användarens språk.
Använd hela konversationens historik för kontext.
Om frågan är otydlig: Ställ en klargörande fråga på användarens språk.
Svara strukturerat och steg-för-steg.
Ignorera irrelevant information i kontexten – fokusera strikt på frågan.
Om inget matchar i guiden: Översätt till användarens språk, t.ex. "I can't find this in the guide. Contact <support@fortuspay.com> or call 010-222 15 20."
Kunskap från FortusPay-guide (översätt vid behov):
${context}      },       ...history     ];       const completion = await [groq.chat](http://groq.chat).completions.create({       model: 'llama-3.3-70b-versatile',       temperature: 0.3,       messages     });       let answer = completion.choices[0].message.content.trim();     answer +=\n\n👉 Personlig hjälp? <support@fortuspay.com> | 010-222 15 20`;
 
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
