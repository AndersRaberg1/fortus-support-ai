import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedGuide = null;
let lastFetch = 0;
const CACHE_TIME = 300000;

const historyStore = new Map();

async function fetchGuide() {
  if (Date.now() - lastFetch > CACHE_TIME || !cachedGuide) {
    const PUBHTML_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';
    
    const res = await fetch(PUBHTML_URL);
    if (!res.ok) throw new Error('Kunde inte hämta guide');
    
    const html = await res.text();

    const cellMatches = html.match(/<td[^>]*>(.*?)<\/td>/g) || [];
    const lines = cellMatches
      .map(match => match.replace(/<[^>]+>/g, '').trim())
      .filter(text => text.length > 0);

    let formattedText = '';
    for (let i = 0; i < lines.length; i += 2) {
      const title = lines[i] || '';
      const content = lines[i + 1] || '';
      if (title || content) {
        formattedText += `### ${title}\n${content}\n\n`;
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

    const lowerQuestion = question.toLowerCase();

    // Prioritera chunks med titel-match
    let relevantChunks = guideText.split('\n\n').filter(chunk => {
      return chunk.toLowerCase().includes(lowerQuestion);
    });

    // Fallback med keywords
    if (relevantChunks.length === 0) {
      relevantChunks = guideText.split('\n\n').filter(chunk => {
        const lowerChunk = chunk.toLowerCase();
        const keywords = ['swish', 'anslut', 'dagsavslut', 'retur', 'kvitto', 'bild', 'stand', 'ställ', 'montera', 'single stand', 'hårdvara', 'fortnox', 'kontrollenhet', 'pos', 'faktura', 'kassa'];
        return keywords.some(kw => lowerChunk.includes(kw));
      });
    }

    const context = relevantChunks.join('\n\n') || guideText;

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `Du är FortusPay Support-AI – vänlig och professionell.
ABSOLUT REGLER:
- SVARA ALLTID PÅ SAMMA SPRÅK SOM FRÅGAN.
- ANVÄND ENDAST OCH EXAKT INFORMATION FRÅN GUIDEN NEDAN – CITERA DIREKT, INKLUDERA LÄNKAR OCH ID.
- SVARA MED "Enligt guiden:" + citat från relevant sektion.
- HALLUCINERA INTE – UPPFINN INGA STEG ELLER DETALJER.
- Om inget matchar: Säg "Enligt guiden finns ingen exakt info om detta – kontakta support@fortuspay.com eller ring 010-222 15 20."
Guide (använd strikt detta):
${context}`
      },
      ...history
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1, // Minimal variation
      messages,
      max_tokens: 600
    });

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
