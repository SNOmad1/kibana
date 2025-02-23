/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { Subject } from 'rxjs';
import { bufferTime, filter as rxFilter, switchMap } from 'rxjs/operators';
import { reject, isUndefined, isNumber, pick } from 'lodash';
import type { PublicMethodsOf } from '@kbn/utility-types';
import { Logger, ElasticsearchClient } from 'src/core/server';
import util from 'util';
import type * as estypes from '@elastic/elasticsearch/lib/api/typesWithBodyKey';
import { fromKueryExpression, toElasticsearchQuery } from '@kbn/es-query';
import { IEvent, IValidatedEvent, SAVED_OBJECT_REL_PRIMARY } from '../types';
import { FindOptionsType } from '../event_log_client';

export const EVENT_BUFFER_TIME = 1000; // milliseconds
export const EVENT_BUFFER_LENGTH = 100;

export type IClusterClientAdapter = PublicMethodsOf<ClusterClientAdapter>;

export interface Doc {
  index: string;
  body: IEvent;
}

type Wait = () => Promise<boolean>;

export interface ConstructorOpts {
  logger: Logger;
  elasticsearchClientPromise: Promise<ElasticsearchClient>;
  wait: Wait;
}

export interface QueryEventsBySavedObjectResult {
  page: number;
  per_page: number;
  total: number;
  data: IValidatedEvent[];
}

interface QueryOptionsEventsBySavedObjectFilter {
  index: string;
  namespace: string | undefined;
  type: string;
  ids: string[];
  findOptions: FindOptionsType;
  legacyIds?: string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AliasAny = any;

const LEGACY_ID_CUTOFF_VERSION = '8.0.0';

export class ClusterClientAdapter<TDoc extends { body: AliasAny; index: string } = Doc> {
  private readonly logger: Logger;
  private readonly elasticsearchClientPromise: Promise<ElasticsearchClient>;
  private readonly docBuffer$: Subject<TDoc>;
  private readonly wait: Wait;
  private readonly docsBufferedFlushed: Promise<void>;

  constructor(opts: ConstructorOpts) {
    this.logger = opts.logger;
    this.elasticsearchClientPromise = opts.elasticsearchClientPromise;
    this.wait = opts.wait;
    this.docBuffer$ = new Subject<TDoc>();

    // buffer event log docs for time / buffer length, ignore empty
    // buffers, then index the buffered docs; kick things off with a
    // promise on the observable, which we'll wait on in shutdown
    this.docsBufferedFlushed = this.docBuffer$
      .pipe(
        bufferTime(EVENT_BUFFER_TIME, null, EVENT_BUFFER_LENGTH),
        rxFilter((docs) => docs.length > 0),
        switchMap(async (docs) => await this.indexDocuments(docs))
      )
      .toPromise();
  }

  // This will be called at plugin stop() time; the assumption is any plugins
  // depending on the event_log will already be stopped, and so will not be
  // writing more event docs.  We complete the docBuffer$ observable,
  // and wait for the docsBufffered$ observable to complete via it's promise,
  // and so should end up writing all events out that pass through, before
  // Kibana shuts down (cleanly).
  public async shutdown(): Promise<void> {
    this.docBuffer$.complete();
    await this.docsBufferedFlushed;
  }

  public indexDocument(doc: TDoc): void {
    this.docBuffer$.next(doc);
  }

  async indexDocuments(docs: TDoc[]): Promise<void> {
    // If es initialization failed, don't try to index.
    // Also, don't log here, we log the failure case in plugin startup
    // instead, otherwise we'd be spamming the log (if done here)
    if (!(await this.wait())) {
      this.logger.debug(`Initialization failed, not indexing ${docs.length} documents`);
      return;
    }

    this.logger.debug(`Indexing ${docs.length} documents`);

    const bulkBody: Array<Record<string, unknown>> = [];

    for (const doc of docs) {
      if (doc.body === undefined) continue;

      bulkBody.push({ create: { _index: doc.index } });
      bulkBody.push(doc.body);
    }

    try {
      const esClient = await this.elasticsearchClientPromise;
      const response = await esClient.bulk({ body: bulkBody });

      if (response.body.errors) {
        const error = new Error('Error writing some bulk events');
        error.stack += '\n' + util.inspect(response.body.items, { depth: null });
        this.logger.error(error);
      }
    } catch (err) {
      this.logger.error(
        `error writing bulk events: "${err.message}"; docs: ${JSON.stringify(bulkBody)}`
      );
    }
  }

  public async doesIlmPolicyExist(policyName: string): Promise<boolean> {
    const request = {
      method: 'GET',
      path: `/_ilm/policy/${policyName}`,
    };
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.transport.request(request);
    } catch (err) {
      if (err.statusCode === 404) return false;
      throw new Error(`error checking existance of ilm policy: ${err.message}`);
    }
    return true;
  }

  public async createIlmPolicy(policyName: string, policy: Record<string, unknown>): Promise<void> {
    const request = {
      method: 'PUT',
      path: `/_ilm/policy/${policyName}`,
      body: policy,
    };
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.transport.request(request);
    } catch (err) {
      throw new Error(`error creating ilm policy: ${err.message}`);
    }
  }

  public async doesIndexTemplateExist(name: string): Promise<boolean> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      const { body: legacyResult } = await esClient.indices.existsTemplate({ name });
      const { body: indexTemplateResult } = await esClient.indices.existsIndexTemplate({ name });
      return (legacyResult as boolean) || (indexTemplateResult as boolean);
    } catch (err) {
      throw new Error(`error checking existence of index template: ${err.message}`);
    }
  }

  public async createIndexTemplate(name: string, template: Record<string, unknown>): Promise<void> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.indices.putIndexTemplate({
        name,
        body: template,
        // @ts-expect-error doesn't exist in @elastic/elasticsearch
        create: true,
      });
    } catch (err) {
      // The error message doesn't have a type attribute we can look to guarantee it's due
      // to the template already existing (only long message) so we'll check ourselves to see
      // if the template now exists. This scenario would happen if you startup multiple Kibana
      // instances at the same time.
      const existsNow = await this.doesIndexTemplateExist(name);
      if (!existsNow) {
        const error = new Error(`error creating index template: ${err.message}`);
        Object.assign(error, { wrapped: err });
        throw error;
      }
    }
  }

  public async getExistingLegacyIndexTemplates(
    indexTemplatePattern: string
  ): Promise<estypes.IndicesGetTemplateResponse> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      const { body: templates } = await esClient.indices.getTemplate(
        { name: indexTemplatePattern },
        { ignore: [404] }
      );
      return templates;
    } catch (err) {
      throw new Error(`error getting existing legacy index templates: ${err.message}`);
    }
  }

  public async setLegacyIndexTemplateToHidden(
    indexTemplateName: string,
    currentIndexTemplate: estypes.IndicesTemplateMapping
  ): Promise<void> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.indices.putTemplate({
        name: indexTemplateName,
        body: {
          ...currentIndexTemplate,
          settings: {
            ...currentIndexTemplate.settings,
            'index.hidden': true,
          },
        },
      });
    } catch (err) {
      throw new Error(
        `error setting existing legacy index template ${indexTemplateName} to hidden: ${err.message}`
      );
    }
  }

  public async getExistingIndices(
    indexPattern: string
  ): Promise<estypes.IndicesGetSettingsResponse> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      const { body: indexSettings } = await esClient.indices.getSettings(
        { index: indexPattern },
        { ignore: [404] }
      );
      return indexSettings;
    } catch (err) {
      throw new Error(
        `error getting existing indices matching pattern ${indexPattern}: ${err.message}`
      );
    }
  }

  public async setIndexToHidden(indexName: string): Promise<void> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.indices.putSettings({
        index: indexName,
        body: {
          'index.hidden': true,
        },
      });
    } catch (err) {
      throw new Error(`error setting existing index ${indexName} to hidden: ${err.message}`);
    }
  }

  public async getExistingIndexAliases(
    indexPattern: string
  ): Promise<estypes.IndicesGetAliasResponse> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      const { body: indexAliases } = await esClient.indices.getAlias(
        { index: indexPattern },
        { ignore: [404] }
      );
      return indexAliases;
    } catch (err) {
      throw new Error(
        `error getting existing index aliases matching pattern ${indexPattern}: ${err.message}`
      );
    }
  }

  public async setIndexAliasToHidden(
    indexName: string,
    currentAliases: estypes.IndicesGetAliasIndexAliases
  ): Promise<void> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.indices.updateAliases({
        body: {
          actions: Object.keys(currentAliases.aliases).map((aliasName) => {
            const existingAliasOptions = pick(currentAliases.aliases[aliasName], [
              'is_write_index',
              'filter',
              'index_routing',
              'routing',
              'search_routing',
            ]);
            return {
              add: {
                ...existingAliasOptions,
                index: indexName,
                alias: aliasName,
                is_hidden: true,
              },
            };
          }),
        },
      });
    } catch (err) {
      throw new Error(
        `error setting existing index aliases for index ${indexName} to is_hidden: ${err.message}`
      );
    }
  }

  public async doesAliasExist(name: string): Promise<boolean> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      const { body } = await esClient.indices.existsAlias({ name });
      return body as boolean;
    } catch (err) {
      throw new Error(`error checking existance of initial index: ${err.message}`);
    }
  }

  public async createIndex(name: string, body: Record<string, unknown> = {}): Promise<void> {
    try {
      const esClient = await this.elasticsearchClientPromise;
      await esClient.indices.create({
        index: name,
        body,
      });
    } catch (err) {
      if (err.body?.error?.type !== 'resource_already_exists_exception') {
        throw new Error(`error creating initial index: ${err.message}`);
      }
    }
  }

  public async queryEventsBySavedObjects(
    queryOptions: QueryOptionsEventsBySavedObjectFilter
  ): Promise<QueryEventsBySavedObjectResult> {
    const { index, namespace, type, ids, findOptions, legacyIds } = queryOptions;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const { page, per_page: perPage, start, end, sort_field, sort_order, filter } = findOptions;

    const defaultNamespaceQuery = {
      bool: {
        must_not: {
          exists: {
            field: 'kibana.saved_objects.namespace',
          },
        },
      },
    };
    const namedNamespaceQuery = {
      term: {
        'kibana.saved_objects.namespace': {
          value: namespace,
        },
      },
    };
    const namespaceQuery = namespace === undefined ? defaultNamespaceQuery : namedNamespaceQuery;

    const esClient = await this.elasticsearchClientPromise;
    let dslFilterQuery: estypes.QueryDslBoolQuery['filter'];
    try {
      dslFilterQuery = filter ? toElasticsearchQuery(fromKueryExpression(filter)) : [];
    } catch (err) {
      this.debug(`Invalid kuery syntax for the filter (${filter}) error:`, {
        message: err.message,
        statusCode: err.statusCode,
      });
      throw err;
    }
    const savedObjectsQueryMust: estypes.QueryDslQueryContainer[] = [
      {
        term: {
          'kibana.saved_objects.rel': {
            value: SAVED_OBJECT_REL_PRIMARY,
          },
        },
      },
      {
        term: {
          'kibana.saved_objects.type': {
            value: type,
          },
        },
      },
      // @ts-expect-error undefined is not assignable as QueryDslTermQuery value
      namespaceQuery,
    ];

    const musts: estypes.QueryDslQueryContainer[] = [
      {
        nested: {
          path: 'kibana.saved_objects',
          query: {
            bool: {
              must: reject(savedObjectsQueryMust, isUndefined),
            },
          },
        },
      },
    ];

    const shouldQuery = [];

    shouldQuery.push({
      bool: {
        must: [
          {
            nested: {
              path: 'kibana.saved_objects',
              query: {
                bool: {
                  must: [
                    {
                      terms: {
                        // default maximum of 65,536 terms, configurable by index.max_terms_count
                        'kibana.saved_objects.id': ids,
                      },
                    },
                  ],
                },
              },
            },
          },
          {
            range: {
              'kibana.version': {
                gte: LEGACY_ID_CUTOFF_VERSION,
              },
            },
          },
        ],
      },
    });

    if (legacyIds && legacyIds.length > 0) {
      shouldQuery.push({
        bool: {
          must: [
            {
              nested: {
                path: 'kibana.saved_objects',
                query: {
                  bool: {
                    must: [
                      {
                        terms: {
                          // default maximum of 65,536 terms, configurable by index.max_terms_count
                          'kibana.saved_objects.id': legacyIds,
                        },
                      },
                    ],
                  },
                },
              },
            },
            {
              bool: {
                should: [
                  {
                    range: {
                      'kibana.version': {
                        lt: LEGACY_ID_CUTOFF_VERSION,
                      },
                    },
                  },
                  {
                    bool: {
                      must_not: {
                        exists: {
                          field: 'kibana.version',
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
    }

    musts.push({
      bool: {
        should: shouldQuery,
      },
    });

    if (start) {
      musts.push({
        range: {
          '@timestamp': {
            gte: start,
          },
        },
      });
    }
    if (end) {
      musts.push({
        range: {
          '@timestamp': {
            lte: end,
          },
        },
      });
    }

    const body: estypes.SearchRequest['body'] = {
      size: perPage,
      from: (page - 1) * perPage,
      sort: [{ [sort_field]: { order: sort_order } }],
      query: {
        bool: {
          filter: dslFilterQuery,
          must: reject(musts, isUndefined),
        },
      },
    };

    try {
      const {
        body: {
          hits: { hits, total },
        },
      } = await esClient.search<IValidatedEvent>({
        index,
        track_total_hits: true,
        body,
      });
      return {
        page,
        per_page: perPage,
        total: isNumber(total) ? total : total!.value,
        data: hits.map((hit) => hit._source),
      };
    } catch (err) {
      throw new Error(
        `querying for Event Log by for type "${type}" and ids "${ids}" failed with: ${err.message}`
      );
    }
  }

  private debug(message: string, object?: unknown) {
    const objectString = object == null ? '' : JSON.stringify(object);
    this.logger.debug(`esContext: ${message} ${objectString}`);
  }
}
