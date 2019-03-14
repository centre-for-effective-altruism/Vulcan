import React, { PureComponent } from 'react';
import { registerComponent, runCallbacks } from 'meteor/vulcan:lib';
import { withApollo } from 'react-apollo';

class RouterHook extends PureComponent {
  constructor(props) {
    super(props);
    this.runOnUpdateCallback(props);
  }

  componentWillReceiveProps(nextProps) {
    this.runOnUpdateCallback(nextProps);
  }

  runOnUpdateCallback = props => {
    const { currentRoute, client } = props;
    // the first argument is an item to iterate on, needed by vulcan:lib/callbacks
    // note: this item is not used in this specific callback: router.onUpdate
    console.log('RouterHook onupdate')
    console.log('  currentRoute', currentRoute)
    // console.log('  client.store', client.store)
    // console.log('  client', client)
    runCallbacks('router.onUpdate', {}, currentRoute, client.store, client);
  };

  render() {
    return null;
  }
}
registerComponent('RouterHook', RouterHook, withApollo);
