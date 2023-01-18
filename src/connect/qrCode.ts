import { sha3_224 } from 'js-sha3';

import {
  PbTypeMessageStatusResp,
  PbTypeMessage,
  PbTypePingCommand,
  PbTypePongCommand,
  PbTypeWeb3MQBridgeConnectResp,
} from '../core/pbType';
import {
  Web3MQBridgeConnectCommand,
  Web3MQMessageStatusResp,
  Web3MQRequestMessage,
  WebsocketPingCommand,
} from '../pb';
import {
  getMessageSharedSecret,
  GetAESBase64Key,
  aesGCMEncrypt,
  Uint8ToBase64String,
  aesGCMDecrypt,
  Base64StringToUint8,
} from '../encryption';
import { sendWeb3mqSignatureCommand, sendWeb3mqBridgeCommand } from './wsCommand';
import { GenerateEd25519KeyPair, GetContactBytes, GenerateQrCode } from '../utils';
import {
  SignClientCallBackType,
  KeyPairsType,
  Web3MQBridgeOptions,
  SendWeb3MQBridgeOptions,
  SignatureParams,
} from '../types';

export class QrCode {
  private _options: Pick<SendWeb3MQBridgeOptions, 'dAppID'>;
  private timeout: number;
  private timeoutObj: null | NodeJS.Timeout;
  ws: WebSocket | null;
  wsUrl: string;
  nodeId: string;
  topicID: string;
  publicKeyProps: string;
  tempKeys: Omit<KeyPairsType, 'userid'> | null;
  // eslint-disable-next-line no-unused-vars
  callback: (params: SignClientCallBackType) => void;

  // eslint-disable-next-line no-unused-vars
  constructor(options: Web3MQBridgeOptions, callback: (params: SignClientCallBackType) => void) {
    this._options = options;
    this.timeout = 55000;
    this.timeoutObj = null;
    this.wsUrl = options.wsUrl;
    this.callback = callback;
    this.ws = null;
    this.nodeId = '';
    this.topicID = '';
    this.tempKeys = null;
    this.publicKeyProps = '';
    this.init();
  }

  private getAesKey = async (targetPubkey: string) => {
    if (!this.tempKeys) {
      return {
        AesKey: '',
        AesIv: '',
      };
    }
    const { PrivateKey } = this.tempKeys;
    const shareKey = await getMessageSharedSecret(PrivateKey, targetPubkey);
    const AesKey = await GetAESBase64Key(shareKey);
    const AesIv = AesKey.slice(0, 16);
    return { AesKey, AesIv };
  };

  private handleGetEncryptData = async (options: SignatureParams) => {
    const { signContent, didValue } = options;
    const { AesKey, AesIv } = await this.getAesKey(this.publicKeyProps);
    const encrytData = await aesGCMEncrypt(
      AesKey,
      AesIv,
      new TextEncoder().encode(
        JSON.stringify({
          action: 'signRequest',
          address: didValue,
          signRaw: signContent,
          proposer: { dAppId: this._options.dAppID, name: '', description: '', url: '', iconUrl: '', redirect: '' },
        }),
      ),
    );
    return encrytData;
  };

  private handleCreateQrCode = async () => {
    const text = `web3mq://?action=connect&topicId=${this.topicID}&ed25519Pubkey=${
      this.tempKeys?.PublicKey
    }&bridge=${encodeURIComponent(this.wsUrl)}&iconUrl=&website=${encodeURIComponent(
      'https://www.baidu.com',
    )}&redirect=`;
    const qrCodeUrl = await GenerateQrCode(text);
    this.callback({ type: 'createQrcode', data: { status: 'success', qrCodeUrl } });
  };

  init() {
    if (!('WebSocket' in window)) {
      throw new Error('Browser not supported WebSocket');
    }
    if (!this.wsUrl) {
      throw new Error('The url is required!');
    }
    const wsconn = new WebSocket(this.wsUrl);
    wsconn.binaryType = 'arraybuffer';
    const { dAppID } = this._options;

    wsconn.onopen = async () => {
      console.log('connection is successful');
      this.start();
      const keys = await GenerateEd25519KeyPair();
      this.tempKeys = keys;
      this.topicID = `${dAppID}@${sha3_224(keys.PublicKey)}`;
      const payload = {
        nodeID: '',
        dAppID,
        topicID: this.topicID,
      };
      const concatArray = await sendWeb3mqBridgeCommand(payload);
      wsconn.send(concatArray);
    };

    wsconn.onmessage = (event) => {
      this.reset();
      var respData = new Uint8Array(event.data);
      const PbType = respData[1];
      const bytes = respData.slice(2, respData.length);
      this.onMessageCallback(PbType, bytes);
    };
    this.ws = wsconn;
  }

  async onMessageCallback(PbType: number, bytes: Uint8Array) {
    console.log(PbType);
    switch (PbType) {
      case PbTypeWeb3MQBridgeConnectResp:
        const resp = Web3MQBridgeConnectCommand.fromBinary(bytes);
        this.nodeId = resp.nodeID;
        this.callback({ type: 'connect', data: 'success' });
        this.handleCreateQrCode();
        break;
      case PbTypePongCommand:
        WebsocketPingCommand.fromBinary(bytes);
        break;
      case PbTypeMessageStatusResp:
        const msgRess = Web3MQMessageStatusResp.fromBinary(bytes);
        console.log(msgRess);
        this.callback({ type: 'messageStatus', data: 'success' });
        break;
      case PbTypeMessage:
        const msgRes = Web3MQRequestMessage.fromBinary(bytes);
        const { content, publicKey } = JSON.parse(
          new TextDecoder().decode(msgRes.payload) || '{content:""}',
        );
        this.publicKeyProps = publicKey;
        const { AesKey, AesIv } = await this.getAesKey(publicKey);
        const decode_data = await aesGCMDecrypt(AesKey, AesIv, Base64StringToUint8(content));
        const data = JSON.parse(new TextDecoder().decode(new Uint8Array(decode_data)));
        this.callback({ type: 'keys', data });
        break;
      default:
        throw new Error('This type is not supported');
    }
  }

  send(arr: Uint8Array) {
    if (!this.ws) {
      throw new Error('websocket Initialization failed');
    }
    return this.ws.send(arr);
  }

  sendSignatureCommand = async (options: SignatureParams) => {
    const encrytData = await this.handleGetEncryptData(options);
    const params = {
      nodeId: this.nodeId,
      payload: new TextEncoder().encode(
        JSON.stringify({
          publicKey: this.tempKeys?.PublicKey,
          content: Uint8ToBase64String(new Uint8Array(encrytData)),
        }),
      ),
      comeFrom: this.topicID,
      contentTopic: this.topicID,
      validatePubKey: this.tempKeys?.PublicKey,
      PrivateKey: this.tempKeys?.PrivateKey,
    };
    const concatArray = await sendWeb3mqSignatureCommand(params);
    this.send(concatArray);
  };

  sendPing() {
    if (this.ws === null) {
      throw new Error('WebSocket is not initialized');
    }
    const timestamp = Date.now();
    const reqCommand: WebsocketPingCommand = {
      timestamp: BigInt(timestamp),
    };
    let bytes = WebsocketPingCommand.toBinary(reqCommand);

    const concatArray = GetContactBytes(PbTypePingCommand, bytes);

    this.ws.send(concatArray);
  }

  reset() {
    if (this.timeoutObj !== null) {
      clearTimeout(this.timeoutObj);
      this.start();
    }
  }

  start() {
    this.timeoutObj = setTimeout(() => {
      this.sendPing();
    }, this.timeout);
  }

  // eslint-disable-next-line no-unused-vars
  receive(pbType: number, bytes?: Uint8Array) {}
}
