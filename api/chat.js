import { Groq } from 'groq-sdk';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let cachedGuide = null;
let lastFetch = 0;
const CACHE_TIME = 5 * 60 * 1000; // 5 minuter

const historyStore = new Map();

/* =========================
   HÄMTA & PARSA GOOGLE SHEET
========================= */
async function fetchGuide() {
  if (cachedGuide && Date.now() - lastFetch < CACHE_TIME) {
    return cachedGuide;
  }

  const PUBHTML_URL =
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pubhtml';

  const res = await fetch(PUBHTML_URL);
  if (!res.ok) {
    throw new Error('Kunde inte hämta guide från Google Sheets');
  }

  const html = await res.text();

  // Extrahera celler
  const cellMatches = html.match(/<td[^>]*>(.*?)<\/td>/g) || [];
  const cells = cellMatches
    .map(c => c.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);

  // Bygg sektioner: titel + innehåll
  const sections = [];
  for (let i = 0; i < cells.length; i += 2) {
    sections.push({
      title: cells[i] || '',
      content: cells[i + 1] || ''
    });
  }

  cachedGuide = sections;
  lastFetch = Date.now();
  return sections;
}

/* =========================
   RELEVANS MATCHNING
========================= */
function scoreSection(section, questionWords) {
  const text = `${section.title} ${section.content}`.toLowerCase();
  let score = 0;

  for (const word of questionWords) {
    if (word.length > 3 && text.includes(word)) {
      score++;
    }
  }
  return score;
}

/* =========================
   API HANDLER
========================= */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { question, sessionId = 'default-session' } = req.body;

  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Ingen fråga angiven' });
  }

  try {
    const guideSections = await fetchGuide();

    const questionWords = question.toLowerCase().split(/\s+/);

    // Scora alla sektioner
    const ranked = guideSections
      .map(sec => ({
        ...sec,
        score: scoreSection(sec, questionWords)
      }))
      .filter(sec => sec.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const context =
      ranked.length > 0
        ? ranked
            .map(
              s =>
                `### ${s.title}\n${s.content}`
            )
            .join('\n\n')
        : '';

    let history = historyStore.get(sessionId) || [];
    history.push({ role: 'user', content: question });

    const messages = [
      {
        role: 'system',
        content: `
Du är FortusPay Support-AI.

VIKTIGA REGLER (får aldrig brytas):
- Svara ALLTID på samma språk som användaren.
- Använd ENDAST information som finns i kunskapsbasen nedan.
- Om svaret inte tydligt finns i kunskapsbasen: säg att du inte hittar det.
- Hitta ALDRIG på information.
- Svara tydligt, professionellt och strukturerat.

Om information saknas, svara:
"Jag hittar inte detta i FortusPays guide. Kontakta support@fortuspay.com eller ring 010-222 15 20."

KUNSKAPSBAS:
${context || 'INGEN MATCHANDE INFORMATION HITTADES.'}
        `.trim()
      },
      ...history
    ];

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      temperature: 0.1, // låg temp = mindre hallucination
      max_tokens: 700,
      messages
    });

    let answer = completion.choices[0].message.content.trim();
    answer += `\n\n👉 Personlig hjälp: support@fortuspay.com | 010-222 15 20`;

    history.push({ role: 'assistant', content: answer });
    if (history.length > 10) history = history.slice(-10);
    historyStore.set(sessionId, history);

    res.status(200).json({ answer });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Tekniskt fel – försök igen senare' });
  }
}

export const config = {
  api: {
    bodyParser: true
  }
};
