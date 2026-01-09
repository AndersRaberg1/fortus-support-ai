module.exports = (req, res) => {
  try {
    console.log('Steg 4: Backend invoked – method:', req.method, 'body:', req.body); // Log vid start
    if (req.method !== 'POST') {
      return res.status(405).send('Method Not Allowed');
    }
    const { message } = req.body || {};
    const reply = `Test-svar från backend: Du skrev '${message || 'inget meddelande'}'. Kommunikation fungerar! Env-test: GROQ_API_KEY = ${process.env.GROQ_API_KEY ? 'satt' : 'saknas'}.`;
    res.status(200).json({ reply });
  } catch (error) {
    console.error('Steg 4: Backend error:', error.message, error.stack); // Log fel-detaljer
    res.status(500).json({ error: 'Serverfel – se Vercel logs' });
  }
};
