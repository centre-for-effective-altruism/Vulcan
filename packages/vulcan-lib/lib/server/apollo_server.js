import { graphqlExpress, graphiqlExpress } from 'apollo-server-express';
import bodyParser from 'body-parser';
import express from 'express';
import { makeExecutableSchema } from 'graphql-tools';
import deepmerge from 'deepmerge';
import DataLoader from 'dataloader';
import { formatError } from 'apollo-errors';
import compression from 'compression';
import { Meteor } from 'meteor/meteor';
import { check } from 'meteor/check';
// import { Accounts } from 'meteor/accounts-base';
import { ApolloEngine } from 'apollo-engine';

import { GraphQLSchema } from '../modules/graphql.js';
import { Utils } from '../modules/utils.js';
import { webAppConnectHandlersUse } from './meteor_patch.js';

import { getSetting, registerSetting } from '../modules/settings.js';
import { Collections } from '../modules/collections.js';
import findByIds from '../modules/findbyids.js';
import { runCallbacks } from '../modules/callbacks.js';
import cookiesMiddleware from 'universal-cookie-express';
// import Cookies from 'universal-cookie';
import { _hashLoginToken, _tokenExpiration } from './accounts_helpers';

import timber from 'timber';
import cors from 'cors';

export let executableSchema;

registerSetting('apolloEngine.logLevel', 'INFO', 'Log level (one of INFO, DEBUG, WARN, ERROR');
registerSetting('apolloTracing', Meteor.isDevelopment, 'Tracing by Apollo. Default is true on development and false on prod', true);

// see https://github.com/apollographql/apollo-cache-control
const timberApiKey = getSetting('timber.apiKey');
const sentryUrl = getSetting('sentry.url');
const sentryEnvironment = getSetting('sentry.environment')
const sentryRelease = getSetting('sentry.release')

const Sentry = require('@sentry/node');
Sentry.init({ dsn: sentryUrl, environment: sentryEnvironment, release: sentryRelease });
if(!sentryUrl) {
  // eslint-disable-next-line no-console
  console.warn("No sentry DNS found, to activate error reporting please set the sentry.url variable in your settings file")
}


const engineApiKey = getSetting('apolloEngine.apiKey');
const engineLogLevel = getSetting('apolloEngine.logLevel', 'INFO')
const engineConfig = {
  apiKey: engineApiKey,
  "origins": [
    {
      requestTimeout: "120s"
    }
  ],
  'stores': [
    {
      'name': 'vulcanCache',
      'inMemory': {
        'cacheSize': 20000000
      }
    }
  ],
  "sessionAuth": {
    "store": "vulcanCache",
    "header": "Authorization"
  },
  // "frontends": [
  //   {
  //     "host": "127.0.0.1",
  //     "port": 3000,
  //     "endpoint": "/graphql",
  //     "extensions": {
  //       "strip": []
  //     }
  //   }
  // ],
  'queryCache': {
    'publicFullQueryStore': 'vulcanCache',
    'privateFullQueryStore': 'vulcanCache'
  },
  // "reporting": {
  //   "endpointUrl": "https://engine-report.apollographql.com",
  //   "debugReports": true
  // },
  'logging': {
    'level': engineLogLevel
  }
};

// defaults
const defaultConfig = {
  path: '/graphql',
  maxAccountsCacheSizeInMB: 1,
  graphiql: true,
  graphiqlPath: '/graphiql',
  graphiqlOptions: {
    passHeader: "'Authorization': localStorage['Meteor.loginToken']", // eslint-disable-line quotes
  },
  configServer: (graphQLServer) => { },
};

const defaultOptions = {
  formatError: e => {
    Sentry.captureException(e)
    return formatError(e)
  },
};

if (Meteor.isDevelopment) {
  defaultOptions.debug = true;
}

// createApolloServer
const createApolloServer = (givenOptions = {}, givenConfig = {}) => {
  const graphiqlOptions = { ...defaultConfig.graphiqlOptions, ...givenConfig.graphiqlOptions };
  const config = { ...defaultConfig, ...givenConfig };
  config.graphiqlOptions = graphiqlOptions;

  const graphQLServer = express();

  // LESSWRONG: Setting up Sentry integration from https://docs.sentry.io/platforms/javascript/express/
  graphQLServer.use(Sentry.Handlers.requestHandler());
  graphQLServer.use(Sentry.Handlers.errorHandler());
  // Optional fallthrough error handler
  graphQLServer.use(function onError(err, req, res, next) {
      // The error id is attached to `res.sentry` to be returned
      // and optionally displayed to the user for support.
      res.statusCode = 500;
      res.end(res.sentry + '\n');
  });


  config.configServer(graphQLServer);



  // cookies
  graphQLServer.use(cookiesMiddleware());

  // compression
  graphQLServer.use(compression());
  // function customDetection(req){
  //   var ipAddress;
  //   ipAddress = req.connection.remoteAddress.replace(/\//g, '.');
  //   console.info("ipAddress: ", ipAddress);
  //   return ipAddress;
  // }


  // LESSWRONG: ACTIVATE IP FILTER
  // graphQLServer.use(IpFilter(["127.0.0.1"], {detectIp: customDetection}));

  // LESSWRONG: USE CORS TO ALLOW MULTIPLE URLS
  graphQLServer.use(cors({origin:[
    "http://lesswrong.com",
    "https://lesswrong.com",
    "http://www.lesswrong.com",
    "https://www.lesswrong.com",
    "http://lesserwrong.com",
    "https://lesserwrong.com",
    "http://www.lesserwrong.com",
    "https://www.lesserwrong.com",
    "http://lessestwrong.com",
    "https://lessestwrong.com",
    "http://www.lessestwrong.com",
    "https://www.lessestwrong.com",
    "https://baserates.org",
    "http://baserates.org",
    "https://www.baserates.org",
    "http://www.baserates.org"
  ]}))

  // GraphQL endpoint
  graphQLServer.use(config.path, bodyParser.json({limit: '30mb'}), graphqlExpress(async (req) => {
    let options;
    let user = null;

    if (typeof givenOptions === 'function') {
      options = givenOptions(req);
    } else {
      options = givenOptions;
    }

    // Merge in the defaults
    options = { ...defaultOptions, ...options };
    if (options.context) {
      // don't mutate the context provided in options
      options.context = { ...options.context };
    } else {
      options.context = {};
    }

    // enable tracing and caching
    options.tracing = getSetting('apolloTracing', Meteor.isDevelopment);
    options.cacheControl = true;

    // note: custom default resolver doesn't currently work
    // see https://github.com/apollographql/apollo-server/issues/716
    // options.fieldResolver = (source, args, context, info) => {
    //   return source[info.fieldName];
    // }

    // Get the token from the header
    if (req.headers.authorization) {
      const token = req.headers.authorization;
      check(token, String);
      const hashedToken = _hashLoginToken(token);

      // Get the user from the database
      user = await Meteor.users.findOne(
        { 'services.resume.loginTokens.hashedToken': hashedToken },
      );

      if (user) {
        //LESSWRONG: Set user in sentry scope
        Sentry.configureScope((scope) => {
          scope.setUser({id: user._id, email: user.email, username: user.username});
        });

        // identify user to any server-side analytics providers
        runCallbacks('events.identify', user);

        const loginToken = Utils.findWhere(user.services.resume.loginTokens, { hashedToken });
        const expiresAt = _tokenExpiration(loginToken.when);
        const isExpired = expiresAt < new Date();

        if (!isExpired) {
          options.context.userId = user._id;
          options.context.currentUser = user;
        }
      }
    }

    //add the headers to the context
    options.context.headers = req.headers;


    // merge with custom context
    options.context = deepmerge(options.context, GraphQLSchema.context);

    // go over context and add Dataloader to each collection
    Collections.forEach(collection => {
      options.context[collection.options.collectionName].loader = new DataLoader(ids => findByIds(collection, ids, options.context), { cache: true });
      // LESSWRONG: Support for custom loaders
      options.context[collection.options.collectionName].extraLoaders = {};
    });

    // console.log('// apollo_server.js user-agent:', req.headers['user-agent']);
    // console.log('// apollo_server.js locale:', req.headers.locale);

    options.context.locale = user && user.locale || req.headers.locale || getSetting('locale', 'en');

    // add error formatting from apollo-errors
    options.formatError = options.formatError || formatError;

    return options;
  }));

  // LESSWRONG: Timber logging integration
  if (timberApiKey) {
    //eslint-disable-next-line no-console
    console.info("Starting timber integration")
    graphQLServer.use(timber.middlewares.express({capture_request_body: true, capture_response_body: true}))
  }

  // Start GraphiQL if enabled
  if (config.graphiql) {
    graphQLServer.use(config.graphiqlPath, graphiqlExpress({ ...config.graphiqlOptions, endpointURL: config.path }));
  }

  // This binds the specified paths to the Express server running Apollo + GraphiQL
  webAppConnectHandlersUse(Meteor.bindEnvironment(graphQLServer), {
    name: 'graphQLServerMiddleware_bindEnvironment',
    order: 30,
  });

  // Use Engine middleware
  if (engineApiKey) {
    let engine = new ApolloEngine({ ...engineConfig });
    engine.meteorListen(WebApp)
  }


};

// createApolloServer when server startup
Meteor.startup(() => {

  runCallbacks('graphql.init.before');

  // typeDefs
  const generateTypeDefs = () => [`
scalar JSON
scalar Date

${GraphQLSchema.getAdditionalSchemas()}

${GraphQLSchema.getCollectionsSchemas()}

type Query {

${GraphQLSchema.queries.map(q => (
    `${q.description ? `  # ${q.description}
` : ''}  ${q.query}
  `)).join('\n')}
}

${GraphQLSchema.mutations.length > 0 ? `type Mutation {

${GraphQLSchema.mutations.map(m => (
`${m.description ? `  # ${m.description}
` : ''}  ${m.mutation}
`)).join('\n')}
}
` : ''}
`];

  const typeDefs = generateTypeDefs();

  GraphQLSchema.finalSchema = typeDefs;

  executableSchema = makeExecutableSchema({
    typeDefs,
    resolvers: GraphQLSchema.resolvers,
    schemaDirectives: GraphQLSchema.directives,
  });

  createApolloServer({
    schema: executableSchema,
  });
});
