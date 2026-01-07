const { Groq } = require('groq-sdk');
const csv = require('csv-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

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

function simpleRAG(query, data) {
  const relevant = data.filter(row => 
    Object.values(row).some(val => val.toLowerCase().includes(query.toLowerCase()))
  );
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
          content: `Du är en hjälpsam support-AI för FortusPay. Svara exakt baserat på kunskapsbasen. Om inget matchar, föreslå mänsklig support. Strukturera svar: **Fråga:** [sammanfattning] **Svar:** [detaljer] **Källa:** [referens]. Kunskapsbas: ${context}`,
        },
        { role: 'user', content: message },
      ],
      model: 'llama-3.1-70b-versatile',
      temperature: 0.5,
      max_tokens: 500,
    });

    const reply = completion.choices[0]?.message?.content || 'Inget svar genererat.';
    res.status(200).json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Serverfel' });
  }
};
