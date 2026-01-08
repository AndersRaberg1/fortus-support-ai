const { Groq } = require('groq-sdk');
const csv = require('csv-parser');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTzsKAX2AsSsvpz0QuNA_8Tx4218SShTDwDCaZXRtmbEG5SumcFM59sJtCzLsm0hHfMXOgnT4kCJMj1/pub?output=csv';
let cachedData = [];
let lastCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minuter

async function loadCSV() {
  if (Date.now() - lastCacheTime < CACHE_DURATION && cachedData.length > 0) {
    return cachedData;
  }
  const response = await fetch(CSV_URL);
  const text = await response.text();
  const results = [];
  return new Promise((resolve, reject) => {
    const stream = require('stream');
    const readable = new stream.Readable();
    readable.push(text);
    readable.push(null);
    readable
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => {
        cachedData = results;
        lastCacheTime = Date.now();
        resolve(results);
      })
      .on('error', reject);
  });
}

// Förbättrad RAG med enkel similarity (utan extra libs) för bättre matchning
function simpleRAG(query, data) {
  const queryLower = query.toLowerCase();
  const relevant = data.filter(row => {
    const values = Object.values(row).join(' ').toLowerCase();
    // Exakt match ELLER enkel overlap (t.ex. >50% ord matchar)
    return values.includes(queryLower) || queryLower.split(' ').some(word => values.includes(word));
  });
  // Sortera efter relevans (längre match först)
  relevant.sort((a, b) => Object.values(b).join(' ').length - Object.values(a).join(' ').length);
  return relevant.map(row => JSON.stringify(row)).join('\n');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }

  try {
    const data = await loadCSV();
    const context = simpleRAG(message, data);

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: 'system',
          content: `Du är en hjälpsam support-AI för FortusPay. Använd ENDAST information från kunskapsbasen för att svara – hallucinera INTE egna svar eller allmän kunskap. Om inget matchar i kunskapsbasen, säg 'Jag hittade ingen specifik info i vår kunskapsbas. Kontakta support@fortuspay.com eller ring 010-222 15 20 för hjälp.' Strukturera svar: **Fråga:** [sammanfattning av användarens fråga] **Svar:** [exakta detaljer från kunskapsbasen, inkludera ID:n, steg etc.] **Källa:** [referens från kunskapsbasen, t.ex. 'Anslut Swish']. Kunskapsbas: ${context || 'Ingen matchande data.'}`,
        },
        { role: 'user', content: message },
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3, // Lägre för mer exakt
      max_tokens: 500,
    });

    const reply = completion.choices[0]?.message?.content || 'Inget svar genererat.';
    res.status(200).json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Serverfel' });
  }
};
