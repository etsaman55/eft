import { makeExecutableSchema } from '@graphql-tools/schema';
import { mergeTypeDefs } from '@graphql-tools/merge';
import { graphql } from 'graphql';
import { v4 as uuidv4 } from 'uuid';

import DataSource from './datasources/index.mjs';
import playground from './handlers/playground.mjs';
import setCors from './utils/setCors.mjs';
import typeDefs from './schema.mjs';
import dynamicTypeDefs from './schema_dynamic.mjs';
import resolvers from './resolvers/index.mjs';
import graphqlUtil from './utils/graphql-util.mjs';
import cacheMachine from './utils/cache-machine.mjs';

import nightbot from './custom-endpoints/nightbot.mjs';
import twitch from './custom-endpoints/twitch.mjs';

let dataAPI;
let schema = false;
let loadingSchema = false;
let lastSchemaRefresh = 0;

const schemaRefreshInterval = 1000 * 60 * 10;

// If the environment is not production, skip using the caching service
const skipCache = false; //ENVIRONMENT !== 'production' || false;

// Example of how router can be used in an application
async function getSchema(data, context) {
    if (schema && new Date() - lastSchemaRefresh < schemaRefreshInterval) {
        return schema;
    }
    if (loadingSchema) {
        return new Promise((resolve) => {
            let loadingTimedOut = false;
            const loadingTimeout = setTimeout(() => {
                loadingTimedOut = true;
            }, 3100);
            const loadingInterval = setInterval(() => {
                if (loadingSchema === false) {
                    clearTimeout(loadingTimeout);
                    clearInterval(loadingInterval);
                    return resolve(schema);
                }
                if (loadingTimedOut) {
                    console.log(`Schema loading timed out; forcing load`);
                    clearInterval(loadingInterval);
                    loadingSchema = false;
                    return resolve(getSchema(data, context));
                }
            }, 100);
        });
    }
    loadingSchema = true;
    return dynamicTypeDefs(data, context).catch(error => {
        loadingSchema = false;
        console.error('Error loading dynamic type definitions', error);
        return Promise.reject(error);
    }).then(dynamicDefs => {
        let mergedDefs;
        try {
            mergedDefs = mergeTypeDefs([typeDefs, dynamicDefs]);
        } catch (error) {
            console.error('Error merging type defs', error);
            return Promise.reject(error);
        }
        try {
            schema = makeExecutableSchema({ typeDefs: mergedDefs, resolvers: resolvers });
            loadingSchema = false;
            //console.log('schema loaded');
            return schema;
        } catch (error) {
            console.error('Error making schema executable');
            if (!error.message) {
                console.error('Check type names in resolvers');
            } else {
                console.error(error.message);
            }
            return Promise.reject(error);
        }
    });
}

async function graphqlHandler(request, env, ctx, graphQLOptions) {
    const url = new URL(request.url);
    let query = false;
    let variables = false;
    const requestStart = new Date();

    if (request.method === 'POST') {
        try {
            const requestBody = await request.json();
            query = requestBody.query;
            variables = requestBody.variables;
        } catch (jsonError) {
            console.error(jsonError);

            return new Response(null, {
                status: 503,
            });
        }
    } else if (request.method === 'GET') {
        query = url.searchParams.get('query');
        variables = url.searchParams.get('variables');
    } else {
        return new Response(null, {
            status: 501,
            headers: { 'cache-control': 'public, max-age=2592000' }
        });
    }
    // Check for empty /graphql query
    if (!query || query.trim() === "") {
        return new Response('GraphQL requires a query in the body of the request',
            {
                status: 200,
                headers: { 'cache-control': 'public, max-age=2592000' }
            }
        );
    }

    // default headers
    const responseOptions = {
        headers: {
            'content-type': 'application/json;charset=UTF-8',
        }
    };

    const requestId = uuidv4();
    console.info(requestId);
    console.log(new Date().toLocaleString('en-US', { timeZone: 'UTC' }));
    console.log(`KVs pre-loaded: ${dataAPI.kvLoaded.join(', ') || 'none'}`);
    //console.log(query);
    if (request.headers.has('x-newrelic-synthetics')) {
        console.log('NewRelic health check');
        //return new Response(JSON.stringify({}), responseOptions);
    }
    let specialCache = '';
    const contentType = request.headers.get('content-type');
    if (!contentType || !contentType.startsWith('application/json')) {
        specialCache = 'application/json';
    }

    // Check the cache service for data first - If cached data exists, return it
    if (!skipCache) {
        const cachedResponse = await cacheMachine.get(env, query, variables, specialCache);
        if (cachedResponse) {
            // Construct a new response with the cached data
            const newResponse = new Response(cachedResponse, responseOptions);
            // Add a custom 'X-CACHE: HIT' header so we know the request hit the cache
            newResponse.headers.append('X-CACHE', 'HIT');
            console.log(`Request served from cache: ${new Date() - requestStart} ms`);
            // Return the new cached response
            return newResponse;
        }
    } else {
        //console.log(`Skipping cache in ${ENVIRONMENT} environment`);
    }

    const context = { data: dataAPI, util: graphqlUtil, requestId, lang: {}, warnings: [], errors: [] };
    let result = await graphql({schema: await getSchema(dataAPI, context), source: query, rootValue: {}, contextValue: context, variableValues: variables});
    console.log('generated graphql response');
    if (context.errors.length > 0) {
        if (!result.errors) {
            result = Object.assign({errors: []}, result); // this puts the errors at the start of the result
        }
        result.errors.push(...context.errors);
    }
    if (context.warnings.length > 0) {
        if (!result.warnings) {
            result = Object.assign({warnings: []}, result);
        }
        result.warnings.push(...context.warnings);
    }

    let ttl = dataAPI.getRequestTtl(requestId);

    if (specialCache === 'application/json') {
        if (!result.warnings) {
            result = Object.assign({warnings: []}, result);
        }
        ttl = 30 * 60;
        result.warnings.push({message: `Your request does not have a "content-type" header set to "application/json". Requests missing this header are limited to resposnes that update every ${ttl/60} minutes.`});
    }

    const body = JSON.stringify(result);

    // Update the cache with the results of the query
    // don't update cache if result contained errors
    if (!skipCache && (!result.errors || result.errors.length === 0) && ttl >= 30) {
        // using waitUntil doens't hold up returning a response but keeps the worker alive as long as needed
        ctx.waitUntil(cacheMachine.put(env, query, variables, body, String(ttl), specialCache));
    }

    console.log(`Response time: ${new Date() - requestStart} ms`);
    //console.log(`${requestId} kvs loaded: ${dataAPI.requests[requestId].kvLoaded.join(', ')}`);
    delete dataAPI.requests[requestId];
    return new Response(body, responseOptions);
}

const graphQLOptions = {
    // Set the path for the GraphQL server
    baseEndpoint: '/graphql',

    // Set the path for the GraphQL playground
    // This option can be removed to disable the playground route
    playgroundEndpoint: '/___graphql',

    // When a request's path isn't matched, forward it to the origin
    forwardUnmatchedRequestsToOrigin: false,

    // Enable debug mode to return script errors directly in browser
    debug: true,

    // Enable CORS headers on GraphQL requests
    // Set to `true` for defaults (see `utils/setCors`),
    // or pass an object to configure each header
    //   cors: true,
    cors: {
        allowCredentials: 'true',
        allowHeaders: 'Content-type',
        allowOrigin: '*',
        allowMethods: 'GET, POST, PUT',
    },

    // Enable KV caching for external REST data source requests
    // Note that you'll need to add a KV namespace called
    // WORKERS_GRAPHQL_CACHE in your wrangler.toml file for this to
    // work! See the project README for more information.
    kvCache: false,
};

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

        try {
            if (url.pathname === '/twitch') {
                const response = request.method === 'OPTIONS' ? new Response('', { status: 204 }) : await twitch(env);
                if (graphQLOptions.cors) {
                    setCors(response, graphQLOptions.cors);
                }

                return response;
            }

            if (!dataAPI) {
                dataAPI = new DataSource(env);
            }
            
            if (url.pathname === '/webhook/nightbot') {
                return nightbot(request, dataAPI, env, ctx);
            }

            if (url.pathname === '/webhook/stream-elements') {
                return nightbot(request, dataAPI, env, ctx);
            }

            if (url.pathname === '/webhook/moobot') {
                return nightbot(request, dataAPI, env, ctx);
            }

            if (url.pathname === graphQLOptions.baseEndpoint) {
                const response = request.method === 'OPTIONS' ? new Response('', { status: 204 }) : await graphqlHandler(request, env, ctx, graphQLOptions);
                if (graphQLOptions.cors) {
                    setCors(response, graphQLOptions.cors);
                }

                return response;
            }

            if (graphQLOptions.playgroundEndpoint && url.pathname === graphQLOptions.playgroundEndpoint) {
                return playground(request, graphQLOptions);
            }

            if (graphQLOptions.forwardUnmatchedRequestsToOrigin) {
                return fetch(request);
            }
            return new Response('Not found', { status: 404 });
        } catch (err) {
            return new Response(graphQLOptions.debug ? err : 'Something went wrong', { status: 500 });
        }
	},
};
