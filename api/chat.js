import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedChunks = null;
let lastFetch = 0;
const CACHE_TIME = 300000; // 5 minuter

const historyStore = new Map();

async function fetchAndChunkGuide() {
  if (Date.now() - lastFetch > CACHE_TIME || !cachedChunks) {
    const PUBHTML_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';
    
    const res = await fetch(PUBHTML_URL);
    if (!res.ok) throw new Error('Kunde inte hämta guide');
    
    const html = await res.text();

    const cellMatches = html.match(/<td[^>]*>(.*?)<\/td>/g) || [];
    const lines = cellMatches
      .map(match => match.replace(/<[^>]+>/g, '').trim())
      .filter(text => text.length > 0);

    const chunks = [];
    for (let i = 0; i < lines.length; i += 2) {
      const title = lines[i] || 'Okänd sektion';
      const content = lines[i + 1] || '';
      if (title || content) {
        chunks.push({
          title: title,
          content: content,
          full: `### ${title}\n${content}`
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

    const lowerQuestion = question.toLowerCase();

    // 1. Prioritera titel-match
    let relevantChunks = chunks.filter(chunk => chunk.title.toLowerCase().includes(lowerQuestion));

    // 2. Fallback: Innehåll eller keywords
    if (relevantChunks.length === 0) {
      relevantChunks = chunks.filter(chunk => {
        const lowerFull = (chunk.title + ' ' + chunk.content).toLowerCase();
        if (lowerFull.includes(lowerQuestion)) return true;
        const keywords = ['swish', 'anslut', 'dagsavslut', 'retur', 'kvitto', 'bild', 'stand', 'ställ', 'montera', 'single stand', 'hårdvara', 'fortnox', 'kontrollenhet', 'pos', 'faktura', 'kassa'];
        return keywords.some(kw => lowerFull.includes(kw));
      });
    }

    // Ta topp 3-5 chunks
    relevantChunks = relevantChunks.slice(0, 5);

    const context = relevantChunks.map(c => c.full).join('\n\n');

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
ABSOLUT REGLER:
- SVARA ALLTID PÅ SAMMA SPRÅK SOM FRÅGAN.
- HITTA MEST RELEVANT SEKTIONS TITEL I CONTEXT NEDAN OCH CITERA ORDAGRANT INNEHÅLLET (INKL LÄNKAR/ID).
- BÖRJA MED "Enligt guiden i sektionen [Titel]:"
- LÄGG INTE TILL, UPPFINN ELLER ÄNDRA NÅGOT – CITERA EXAKT.
- Om ingen match: "Enligt guiden finns ingen exakt info – kontakta support@fortuspay.com eller ring 010-222 15 20."
Relevant context från guiden:
${context || 'Ingen relevant sektion hittades.'}`
      },
      ...history
    ];

    const completionPromise = groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.0,
      messages,
      max_tokens: 600
    });

    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 12000));

    const completion = await Promise.race([completionPromise, timeoutPromise]);

    let answer = completion.choices[0].message.content.trim();
    answer += `\n\n👉 Personlig hjälp? support@fortuspay.com | 010-222 15 20`;

    history.push({ role: 'assistant', content: answer });
    if (history.length > 10) history = history.slice(-10);
    historyStore.set(sessionId, history);

    res.status(200).json({ answer });
  } catch (error) {
    console.error('Error:', error.message || error);
    res.status(500).json({ error: 'Tekniskt fel – försök igen om en stund' });
  }
}

export const config = {
  api: {
    bodyParser: true,
  },
};
