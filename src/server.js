'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const auth = require('./auth');
const helpers = require('./helpers');
const esi = require('./esi');
const { migrate, config } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BOARD_NAME = process.env.BOARD_NAME || 'Thunderdome';

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

app.use((req, res, next) => {
  res.locals.boardName = BOARD_NAME;
  res.locals.h = helpers;
  res.locals.esi = esi;
  res.locals.path = req.path;
  res.locals.query = req.query;
  next();
});

app.use(auth.session);

// The API authenticates with its own key, so it sits outside the site gate.
app.use('/api', require('./routes/api'));

app.use(auth.requireSite);
app.use('/', require('./routes/auth'));
app.use('/admin', require('./routes/admin'));
app.use('/', require('./routes/board'));

app.use((req, res) => {
  res.status(404).render('message', { title: 'Not found', message: 'Nothing here. Try the search box.' });
});

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  const status = err.status || 500;
  if (req.path.startsWith('/api/')) return res.status(status).json({ error: err.message });
  res.status(status).render('message', { title: 'Something broke', message: err.message });
});

/**
 * Applies the schema and warms the artwork cache. Must finish before the first
 * request: templates read type IDs synchronously from that cache.
 */
async function init() {
  await migrate();
  const cached = await esi.loadCache();
  console.log(`[db] ready (${config.url.split('?')[0]}), ${cached} type ids cached`);
}

if (require.main === module) {
  init()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`${BOARD_NAME} killboard listening on :${PORT}`);
        esi.retryUnresolved().catch(() => {});
      });
    })
    .catch((err) => {
      console.error('[startup] failed:', err);
      process.exit(1);
    });
}

module.exports = app;
module.exports.init = init;
