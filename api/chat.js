module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }
  try {
    const reply = `Test-svar från API: Du skrev '${message}'. Miljövariabel-test: GROQ_API_KEY = ${process.env.GROQ_API_KEY ? 'satt' : 'saknas'}.`;
    res.status(200).json({ reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Serverfel' });
  }
};
