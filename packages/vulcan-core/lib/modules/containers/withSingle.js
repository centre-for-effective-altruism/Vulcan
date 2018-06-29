import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { graphql } from 'react-apollo';
import gql from 'graphql-tag';
import { getSetting, getFragment, getFragmentName, getCollection, singleClientTemplate, Utils } from 'meteor/vulcan:lib';

export default function withSingle(options) {

<<<<<<< HEAD:packages/vulcan-core/lib/modules/containers/withSingle.js
  const {
    collectionName,
    pollInterval = getSetting('pollInterval', 0),
    enableCache = false,
    extraQueries,
    ssr = false
  } = options;
=======
  const { collectionName, pollInterval = getSetting('pollInterval', 0), enableCache = false, extraQueries, ssr = false } = options;
>>>>>>> Changed all containers to not query for data in SSR by default:packages/vulcan-core/lib/modules/containers/withDocument.js

  const collection = options.collection || getCollection(collectionName);
  const typeName = collection.options.typeName;
  const resolverName = Utils.camelCaseify(typeName);

  let fragment;

  if (options.fragment) {
    fragment = options.fragment;
  } else if (options.fragmentName) {
    fragment = getFragment(options.fragmentName);
  } else {
    fragment = getFragment(`${collection.options.collectionName}DefaultFragment`);
  }

  const fragmentName = getFragmentName(fragment);

  const query = gql`${singleClientTemplate({ typeName, fragmentName, extraQueries })}${fragment}`;

  return graphql(query, {
    alias: `with${typeName}`,

    options({ documentId, slug }) {
      const graphQLOptions = {
        variables: {
          input: {
            selector: {
              documentId,
              slug,
            },
            enableCache,
          }
        },
        pollInterval, // note: pollInterval can be set to 0 to disable polling (20s by default)
        ssr,
      };

      if (options.fetchPolicy) {
        graphQLOptions.fetchPolicy = options.fetchPolicy;
      }

      return graphQLOptions;
    },
    props: returnedProps => {
      const { /* ownProps, */ data } = returnedProps;

      const propertyName = options.propertyName || 'document';
      const props = {
        loading: data.loading,
        // document: Utils.convertDates(collection, data[singleResolverName]),
        [propertyName]: data[resolverName] && data[resolverName].result,
        fragmentName,
        fragment,
        data,
      };

      if (data.error) {
        // get graphQL error (see https://github.com/thebigredgeek/apollo-errors/issues/12)
        props.error = data.error.graphQLErrors[0];
      }

      return props;
    },
  });
}
