/**
 * VLESS Proxy - Cloudflare Pages Functions
 * 完整的 VLESS 协议实现
 */

// @ts-ignore
import { connect } from 'cloudflare:sockets';

// UUID 配置
const UUID = '14694400-88b4-4c77-9072-adfb729652cd';

// 默认代理IP - 使用日本节点（51ms延迟）
let proxyIP = '162.159.201.1';

// 连接超时设置（毫秒）
const CONNECT_TIMEOUT = 10000;
const SOCKET_TIMEOUT = 30000;

// 备用代理IP列表（按速度排序）
const backupProxyIPs = [
    '162.159.201.1',  // 日本节点 - 51ms（最快）
    '162.159.195.1',  // 香港节点 - 169ms
    '162.159.204.1',  // 新加坡节点 - 152ms
    '162.159.138.1',  // 通用节点 - 145ms
    '162.159.137.1',  // 通用节点 - 155ms
    '1.1.1.1',        // Cloudflare DNS
    '8.8.8.8'         // Google DNS
];

// DNS服务器
const dnsServers = [
    'https://1.1.1.1/dns-query',
    'https://8.8.8.8/dns-query',
    'https://9.9.9.9/dns-query'
];

// WebSocket状态
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// 处理所有请求
export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);
    
    // 检查 WebSocket 升级
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        return vlessOverWSHandler(request);
    }
    
    // 健康检查端点
    if (url.pathname === '/' || url.pathname === '/health') {
        return new Response(JSON.stringify({
            status: 'ok',
            service: 'VLESS Proxy - Pages Functions',
            version: '2.0',
            uuid: UUID,
            domain: url.hostname,
            timestamp: new Date().toISOString(),
            cf: {
                colo: request.cf?.colo,
                country: request.cf?.country
            }
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*'
            }
        });
    }
    
    // 配置信息端点
    if (url.pathname === '/config') {
        const vlessLink = `vless://${UUID}@${url.hostname}:443?encryption=none&security=tls&sni=${url.hostname}&fp=randomized&type=ws&host=${url.hostname}&path=%2F%3Fed%3D2048#VLESS-Pages`;
        
        return new Response(JSON.stringify({
            uuid: UUID,
            server: url.hostname,
            port: 443,
            encryption: 'none',
            security: 'tls',
            type: 'ws',
            host: url.hostname,
            path: '/?ed=2048',
            vless_link: vlessLink,
            note: '使用此配置连接 VLESS 客户端'
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });
    }
    
    // 状态检查
    if (url.pathname === '/status') {
        return new Response(JSON.stringify({
            status: 'running',
            uuid: UUID,
            proxy_ip: proxyIP,
            backup_ips: backupProxyIPs.length,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    }
    
    // 其他路径返回 404
    return new Response('Not Found', { status: 404 });
}

/**
 * 处理 WebSocket VLESS 连接
 */
async function vlessOverWSHandler(request) {
    // @ts-ignore
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    
    webSocket.accept();
    
    let address = '';
    let portWithRandomLog = '';
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };
    
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    
    let remoteSocketWapper = { value: null };
    let udpStreamWrite = null;
    let isDns = false;
    
    // ws --> remote
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            
            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                vlessVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processVlessHeader(chunk, UUID);
            
            address = addressRemote;
            portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;
            
            if (hasError) {
                log('VLESS header error:', message);
                webSocket.close(1008, message);
                return;
            }
            
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    log('UDP proxy rejected - not DNS port');
                    webSocket.close(1008, 'UDP proxy only enabled for DNS');
                    return;
                }
            }
            
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }
            
            await handleTCPOutBound(
                remoteSocketWapper,
                addressRemote,
                portRemote,
                rawClientData,
                webSocket,
                vlessResponseHeader,
                log
            );
        },
        close() {
            log('readableWebSocketStream is closed');
        },
        abort(reason) {
            log('readableWebSocketStream is aborted', JSON.stringify(reason));
        },
    })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
        webSocket.close(1011, 'Internal error');
    });
    
    return new Response(null, {
        status: 101,
        // @ts-ignore
        webSocket: client,
    });
}

/**
 * 处理 TCP 出站连接
 * 参考 zizifn/edgetunnel 的正确实现
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        
        return tcpSocket;
    }
    
    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        tcpSocket.closed.catch(error => {
            console.log('retry tcpSocket closed error', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
    }
    
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 创建 WebSocket 可读流
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) return;
                controller.enqueue(event.data);
            });
            
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (!readableStreamCancel) {
                    controller.close();
                }
            });
            
            webSocketServer.addEventListener('error', (err) => {
                controller.error(err);
            });
            
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {},
        cancel(reason) {
            if (readableStreamCancel) return;
            log(`ReadableStream was canceled, due to ${reason}`);
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
    return stream;
}

/**
 * 处理 VLESS 协议头
 */
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true, message: 'invalid data' };
    }
    
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    
    if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
        isValidUser = true;
    }
    
    if (!isValidUser) {
        return { hasError: true, message: 'invalid user' };
    }
    
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    
    if (command === 1) {
        // TCP
    } else if (command === 2) {
        isUDP = true;
    } else {
        return { hasError: true, message: `command ${command} is not support` };
    }
    
    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true, message: `invalid addressType ${addressType}` };
    }
    
    if (!addressValue) {
        return { hasError: true, message: `addressValue is empty` };
    }
    
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP,
    };
}

/**
 * 远程 Socket 转发到 WebSocket
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
    let vlessHeader = vlessResponseHeader;
    let hasIncomingData = false;
    
    await remoteSocket.readable.pipeTo(
        new WritableStream({
            start() {},
            async write(chunk, controller) {
                hasIncomingData = true;
                if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                    controller.error('webSocket.readyState is not open');
                }
                if (vlessHeader) {
                    webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
                    vlessHeader = null;
                } else {
                    webSocket.send(chunk);
                }
            },
            close() {
                log(`remoteConnection.readable is closed with hasIncomingData: ${hasIncomingData}`);
            },
            abort(reason) {
                log(`remoteConnection.readable abort`, reason);
            },
        })
    ).catch((error) => {
        log(`remoteSocketToWS exception`, error.stack || error);
        safeCloseWebSocket(webSocket);
    });
    
    if (hasIncomingData === false && retry) {
        log(`No incoming data, starting retry`);
        retry();
    }
}

/**
 * 处理 UDP 出站（DNS）
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        start(controller) {},
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index = index + 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) {}
    });
    
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            for (const dnsServer of dnsServers) {
                try {
                    const resp = await fetch(dnsServer, {
                        method: 'POST',
                        headers: { 'content-type': 'application/dns-message' },
                        body: chunk,
                    });
                    
                    if (resp.ok) {
                        const dnsQueryResult = await resp.arrayBuffer();
                        const udpSize = dnsQueryResult.byteLength;
                        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
                        
                        if (webSocket.readyState === WS_READY_STATE_OPEN) {
                            if (isVlessHeaderSent) {
                                webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                            } else {
                                webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                                isVlessHeaderSent = true;
                            }
                        }
                        return;
                    }
                } catch (error) {
                    log(`DNS server ${dnsServer} failed: ${error.message}`);
                }
            }
        }
    })).catch((error) => {
        log('DNS UDP error: ' + error);
    });
    
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}

/**
 * Base64 解码
 */
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

/**
 * 安全关闭 WebSocket
 */
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}

/**
 * UUID 验证
 */
function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}

// UUID 字符串转换
const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}
