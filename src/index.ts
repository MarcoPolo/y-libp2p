import * as Y from 'yjs'
import type { Doc as YDoc } from 'yjs'
import type Libp2p from 'libp2p'
import { Uint8ArrayEquals } from './util'
import PeerId from 'peer-id'
import type { BufferList } from 'libp2p-interfaces/src/pubsub'
import { Connection } from 'libp2p-interfaces/src/topology'
// @ts-ignore
import * as awarenessProtocol from 'y-protocols/dist/awareness.cjs'
import type { Awareness } from 'y-protocols/awareness'

// the Muxedstream type is wrong for the protocol streams
type ProtocolStream = {
  sink: (data: Iterable<any> | AsyncIterable<any>) => Promise<void>
  source: AsyncIterable<BufferList>
  close: () => void
}

function changesTopic(topic: string): string {
  return `${topic}/changes`
}

function stateVectorTopic(topic: string): string {
  return `${topic}/stateVector`
}

function syncProtocol(topic: string): string {
  return `${topic}/sync/0.0.1`
}

function awarenessProtocolTopic(topic: string): string {
  return `${topic}/awareness/0.0.1`
}

class Provider {
  ydoc: YDoc;
  node: Libp2p;
  peerID: string;
  topic: string
  stateVectors: { [key: string]: Uint8Array } = {};
  unsyncedPeers: Set<string> = new Set();

  public awareness: Awareness;

  aggressivelyKeepPeersUpdated: boolean = true;

  constructor(ydoc: YDoc, node: Libp2p, topic: string) {
    this.ydoc = ydoc;
    this.node = node;
    this.topic = topic;
    this.peerID = this.node.peerId.toB58String()
    this.stateVectors[this.peerID] = Y.encodeStateVector(this.ydoc)
    this.awareness = new awarenessProtocol.Awareness(ydoc)

    this.awareness.setLocalStateField("user", {
      name: this.peerID
    })

    ydoc.on('update', this.onUpdate.bind(this));

    node.pubsub.subscribe(changesTopic(topic))
    node.pubsub.on(changesTopic(topic), this.onPubSubChanges.bind(this));

    node.pubsub.subscribe(stateVectorTopic(topic))
    node.pubsub.on(stateVectorTopic(topic), this.onPubSubStateVector.bind(this));

    node.pubsub.subscribe(awarenessProtocolTopic(topic))
    node.pubsub.on(awarenessProtocolTopic(topic), this.onPubSubAwareness.bind(this));

    // @ts-ignore
    node.handle(syncProtocol(topic), this.onSyncMsg.bind(this));
  }

  private onUpdate(updateData: Uint8Array, origin: this | any) {
    if (origin !== this) {
      this.publishUpdate(updateData);

      return
    }
  }

  private publishUpdate(updateData: Uint8Array) {
    if (!this.node.isStarted()) {
      return
    }

    this.node.pubsub.publish(changesTopic(this.topic), updateData);
    const stateV = Y.encodeStateVector(this.ydoc)
    this.stateVectors[this.peerID] = stateV;
    this.node.pubsub.publish(stateVectorTopic(this.topic), stateV);

    // Publish awareness as well
    this.node.pubsub.publish(awarenessProtocolTopic(this.topic), awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]))
  }

  private onPubSubChanges(msg: any) {
    this.updateYdoc(msg.data, this);
  }

  private onPubSubStateVector(msg: any) {
    this.stateVectors[msg.from] = msg.data;

    if (!Uint8ArrayEquals(msg.data, this.stateVectors[this.peerID])) {
      // Bookkeep that this peer is out of date
      // console.log("Peer is out of date", msg.from)
      this.queuePeerSync(msg.from);
    }
  }

  private onPubSubAwareness(msg: any) {
    // console.log("Got awareness update", msg)
    awarenessProtocol.applyAwarenessUpdate(this.awareness, msg.data, this)
  }

  private updateYdoc(updateData: Uint8Array, origin: any) {
    Y.applyUpdate(this.ydoc, updateData, this);
    this.stateVectors[this.peerID] = Y.encodeStateVector(this.ydoc)
  }

  storeStateVector(peerID: string, stateVector: Uint8Array) {
    this.stateVectors[peerID] = stateVector;
  }

  fetchStateVector(peerID: string) {
    return this.stateVectors[peerID];
  }

  private async runSyncProtocol(stream: ProtocolStream, remotePeer: string, initiate: boolean) {
    if (initiate) {
      await stream.sink([
        this.stateVectors[this.peerID],
        Y.encodeStateAsUpdate(this.ydoc, this.stateVectors[remotePeer])
      ])
    }

    const [{ value: stateVector }, { value: updateData }] = [
      await stream.source[Symbol.asyncIterator]().next(),
      await stream.source[Symbol.asyncIterator]().next()
    ]
    this.stateVectors[remotePeer] = stateVector.slice(0);
    this.updateYdoc(updateData.slice(0), this);

    if (!initiate) {
      await stream.sink([
        Y.encodeStateVector(this.ydoc),
        Y.encodeStateAsUpdate(this.ydoc, this.stateVectors[remotePeer])
      ])
    }

    stream.close()
  }

  private async onSyncMsg({ stream, connection, ...rest }: { stream: ProtocolStream, connection: Connection }) {
    await this.runSyncProtocol(stream, connection.remotePeer.toB58String(), false)
  }

  private queuePeerSync(peerID: string) {
    this.unsyncedPeers.add(peerID);
    if (this.aggressivelyKeepPeersUpdated) {
      for (const peerID of this.unsyncedPeers) {
        this.syncPeer(peerID).catch(console.error);
      }
    } else {
      throw new Error("Not implemented")
    }
  }

  private async syncPeer(peerID: string) {
    const thiz = this;
    const multiaddrs = await this.node.peerStore.addressBook.getMultiaddrsForPeer(PeerId.createFromB58String(peerID));
    let success = false;
    if (!multiaddrs) {
      return
    }
    for (const ma of multiaddrs) {
      const maStr = ma.toString()
      try {
        const { stream } = await this.node.dialProtocol(maStr, syncProtocol(this.topic)) as any as { stream: ProtocolStream }
        await this.runSyncProtocol(stream, peerID, true)
        success = true;
        return
      } catch (e) {
        console.warn(`Failed to sync with ${maStr}`, e)
        continue;
      }
    }

    throw new Error("Failed to sync with peer")
  }
}

// TODO awareness

export default Provider