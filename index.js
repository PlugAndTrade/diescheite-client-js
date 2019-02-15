const R = require('ramda'),
      { dispatch } = require('nact'),
      uuid = require('uuid/v4'),
      { spawnHelper } = require('./utils'),
      { findRoute } = require('./express'),
      { PUBLISH } = require('./actions'),
      tracingScope = require('./tracingScope'),
      LogEntry = require('./log-entry');

const delay = t => new Promise((resolve) => t <= 0 ? setImmediate(resolve) : setTimeout(resolve, t));

const consolePublisherActions = {
  [PUBLISH]: (state, { entry }, ctx) => {
    dispatch(ctx.sender, delay(0)
      .then(() => {
        console.log(JSON.stringify(entry, null, 2));
        return {};
      })
    );
    return state;
  }
};

const headersFilter = (censoredHeaders, ignoredHeaders) => R.pipe(
  R.omit(ignoredHeaders),
  R.mapObjIndexed((val, key) => key in censoredHeaders ? '<censored>' : val)
);

const DEFAULT_MIDDLEWARE_OPTS = {
  censoredHeaders: [
    'authorization',
    'user-agent',
  ],
  ignoredHeaders: [
    'host',
    'date',
    'x-powered-by',
    'x-scope-id',
  ],
  ignoredRoutes: [
    '/healthcheck'
  ]
};


module.exports = function ({actorParent, ...config}) {
  const serviceInfo = R.pick([ 'serviceId', 'serviceInstanceId', 'serviceVersion' ], config);
  const publisher = spawnHelper(actorParent, consolePublisherActions, {});

  function loggedAction(scope, action) {
    let entry = R.pipe(
      R.pick([ 'id', 'parentId', 'correlationId', 'protocol', 'route' ]),
      R.mergeLeft(serviceInfo),
    )(scope);

    let logger = LogEntry(entry, publisher);

    logger.init();
    return new Promise((resolve, reject) => Promise.resolve(action(logger)).then(resolve).catch(reject))
      .then(result => ({ result, published: logger.finalize() }));
  }

  function middleware(opts, app) {
    opts = R.mergeRight(DEFAULT_MIDDLEWARE_OPTS, opts);

    const ignoredRoutes = R.map(R.constructN(1, RegExp))(opts.ignoredRoutes);
    const ignoredRoute = (route) => R.any(R.invoker(1, 'test')(route), ignoredRoutes)

    const filterHeaders = headersFilter(
      R.reduce(R.flip(R.assoc(R.__, true)), {})(opts.censoredHeaders),
      opts.ignoredHeaders
    );

    function logger(req, res, next) {
      if (ignoredRoute(req.originalUrl)) {
        next();
        return;
      }

      let scope = tracingScope.generic({
        correlationId: req.headers['x-correlation-id'],
        parentId: req.headers['x-parent-scope-id'],
        route: app ? findRoute(req, app).pattern : '',
        protocol: 'http'
      });

      res.set('X-Scope-Id', scope.id);

      loggedAction(scope, entry => {
        req.logger = entry;
        next();
        return new Promise((resolve) => {
          res.on('close', () => {
            req.logger.extend('http', {
              request: {
                method: req.method,
                host: req.hostname,
                uri: req.originalUrl,
                headers: filterHeaders(req.headers)
              },
              response: res.finished
                ? { statusCode: res.statusCode, headers: filterHeaders(res.getHeaders()) }
                : null
            });
            resolve();
          });
        });
      });
    }

    function errorHandler(err, req, res, next) {
      if (req.logger) {
        req.logger.error(`Uncaught error: ${err}`, err.stack);
      } else {
        next(err);
      }
    }

    return {
      logger,
      errorHandler
    };
  }

  function stop() {
    stop(publisher);
  }

  return {
    loggedAction,
    middleware,
    stop,
  };
};
