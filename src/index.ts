import * as Y from 'yjs'
import type { Doc as YDoc } from 'yjs'
import { Libp2p as ILibp2p } from "libp2p";
import { Uint8ArrayEquals } from './util.js'
import { Connection } from '@libp2p/interface-connection';
// @ts-ignore
import * as awarenessProtocol from 'y-protocols/dist/awareness.cjs'
import type { Awareness } from 'y-protocols/awareness'

import { peerIdFromString } from "@libp2p/peer-id";

// the Muxedstream type is wrong for the protocol streams
type ProtocolStream = {
  sink: (data: Iterable<any> | AsyncIterable<any>) => Promise<void>
  source: AsyncIterable<Uint8Array>
  close: () => void
}


function changesTopic(topic: string): string {
  return `/marcopolo/gossipPad/${topic}/changes/0.0.01`;
}

function stateVectorTopic(topic: string): string {
  return `/marcopolo/gossipPad/${topic}/stateVector/0.0.1`
}

function syncProtocol(topic: string): string {
  return `/marcopolo/gossipPad/${topic}/sync/0.0.1`
}

function awarenessProtocolTopic(topic: string): string {
  return `/marcopolo/gossipPad/${topic}/awareness/0.0.1`
}

export class Provider {  
  ydoc: YDoc;
  node: ILibp2p;
  peerID: string;
  topic: string
  stateVectors: { [key: string]: Uint8Array } = {};
  unsyncedPeers: Set<string> = new Set();
  initialSync = false;

  public awareness: Awareness;

  aggressivelyKeepPeersUpdated: boolean = true;

  constructor(ydoc: YDoc, node: ILibp2p, topic: string) {
    this.ydoc = ydoc;
    this.node = node;
    this.topic = topic;
    this.peerID = this.node.peerId.toString()
    this.stateVectors[this.peerID] = Y.encodeStateVector(this.ydoc)
    this.awareness = new awarenessProtocol.Awareness(ydoc)

    this.awareness.setLocalStateField("user", {
      name: this.peerID
    })

    ydoc.on('update', this.onUpdate.bind(this));

    node.pubsub.subscribe(changesTopic(topic))
    node.pubsub.subscribe(stateVectorTopic(topic))
    node.pubsub.subscribe(awarenessProtocolTopic(topic))

    this.node.pubsub.addEventListener('message', async (event) => {
      if (event.detail.topic === changesTopic(topic)) {
        this.onPubSubChanges.bind(this)
      }

      if (event.detail.topic === stateVectorTopic(topic)) {
        this.onPubSubStateVector.bind(this)
      }

      if (event.detail.topic === awarenessProtocolTopic(topic)) {
        this.onPubSubAwareness.bind(this)
      }
    });
    
    // @ts-ignore
    node.handle(syncProtocol(topic), this.onSyncMsg.bind(this));

    this.tryInitialSync(this.stateVectors[this.peerID], this);
  }

  destroy() {
    this.node.pubsub.unsubscribe(changesTopic(this.topic))
    this.node.pubsub.unsubscribe(stateVectorTopic(this.topic))
    this.node.pubsub.unsubscribe(awarenessProtocolTopic(this.topic))

    this.node.pubsub.removeEventListener('message');

    // @ts-ignore
    node.unhandle(syncProtocol(topic))

    this.initialSync = true;
  }

  // Not required, but nice if we can get synced against a peer sooner rather than latter
  private async tryInitialSync(updateData: Uint8Array, origin: this | any): Promise<Boolean | void> {
    const tries = 10;
    const maxWaitTime = 1000;
    let waitTime = 100;
    for (let i = 0; i < tries; i++) {
      if (this.initialSync) {
        return
      }

      // needed to type hack 
      const peers = [...(this.node as any).pubsub.topics.get(stateVectorTopic(this.topic)) || []]

      if (peers.length !== 0) {
        const peer = peers[i % peers.length]
        try {
          await this.syncPeer(peer)
          this.initialSync = true;
          return true
        } catch (e) {
          console.warn("failed to sync with anyone", e)
        }
      }

      await new Promise(resolve => setTimeout(resolve, waitTime))
      waitTime = Math.min(waitTime * 2, maxWaitTime)
    }
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
    this.initialSync = true;
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
    await this.runSyncProtocol(stream, connection.remotePeer.toString(), false)
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
    let success = false;
    try {
      const stream = await this.node.dialProtocol(peerIdFromString(peerID), syncProtocol(this.topic)) as any as { stream: ProtocolStream }
      await this.runSyncProtocol(stream as any, peerID, true)
      success = true;
      return
    } catch (e) {
      console.warn(`Failed to sync with ${peerIdFromString(peerID)}`, e)
    }

    throw new Error("Failed to sync with peer")
  }
}

// TODO awareness

