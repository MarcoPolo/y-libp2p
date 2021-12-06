# y-libp2p

[libp2p](https://libp2p.io/) provider for [Yjs](https://github.com/yjs/yjs).
Uses [gossipsub](https://github.com/libp2p/specs/tree/master/pubsub/gossipsub)
to share updates.

Demo: todo

## Usage

```js
import Libp2p from 'libp2p'
import Provider from 'y-libp2p'

async function() {

  const node = await Libp2p.create({
    // libp2p options...
  })
  await node.start
  const provider = new Provider(yDoc, node, gossipSubTopic);
}
```
