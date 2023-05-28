import ElectrumClient from '@tkone7/electrum-client-js';
import { BITBOX } from 'bitbox-sdk';
import { Contract } from '@mainnet-cash/contract';
import { Network } from 'mainnet-js';

var CONFIG = {
    MAINNET: true,
    ElectrumHost: 'scaling.cash', // '3.0.176.219'
    ElectrumPort: 50004, // 50003
    ElectrumProto: "wss", // "ws"
    LOOP_Mint_ENABLE: false
}

let bitbox = new BITBOX();
let electrum

const covenantNetwork = CONFIG.MAINNET ? Network.MAINNET : Network.TESTNET
const network = CONFIG.MAINNET ? 'mainnet' : 'testnet'

export async function newClient() {
    if (electrum) {
        return electrum
    }
    const electrum_ = new ElectrumClient(CONFIG.ElectrumHost, CONFIG.ElectrumPort, CONFIG.ElectrumProto);
    await electrum_.connect(
        'electrum-client-js', // optional client name
        '1.4.2' // optional protocol version
    )
    electrum = electrum_
    return electrum
}

async function getUtxosByAddress(address) {
    return await electrum.blockchain_address_listunspent(address);
}

export async function getTxByTxid(txid) {
    return await electrum.blockchain_transaction_get(txid, true);
}

async function getMetaInfoForSymbol(tx, symbol, checkSymbol = true, categoryWanted) {
    // console.log('getMetaInfoForSymbol, sym:', symbol, 'txd:', genesisTxId);

    let mintAmt; //released token amount for each mint
    if (tx.vout.length == 3
        && tx.vout[2].scriptPubKey?.type == 'nulldata'
        && tx.vout[2].scriptPubKey?.hex?.length == 20
        && tx.vout[2].scriptPubKey?.hex.startsWith('6a08')) {

        mintAmt = Number('0x' + tx.vout[2].scriptPubKey.hex.substr(4));
    }
    for (let i in tx.vout) {
        let vout = tx.vout[i]
        let tokenData = vout.tokenData
        if (tokenData !== undefined) {
            let category = tokenData.category
            if (!checkSymbol && category != categoryWanted) {
                continue
            }
            for (let j in tx.vin) {
                let vin = tx.vin[j]
                // if we find the genesis input for this token category
                if (category === vin.txid && vin.vout === 0) {
                    // vin[j] spends a genesis output
                    let commitTx = await getTxByTxid(vin.txid) // this tx committed the MetaInfo
                    const result = await getMetaInfoFromGenesisOutput(commitTx.vout[0].scriptPubKey.hex, vin.scriptSig.hex)
                    if (result) {
                        if (checkSymbol && result.symbol == symbol) {
                            return [category, result.name, result.decimals, mintAmt, tx.confirmations, tokenData.amount];
                        }
                        if (!checkSymbol) {
                            return [result.symbol, category, result.name, result.decimals, mintAmt, tx.confirmations, tokenData.amount];
                        }
                    }
                }
            }
        }
    }
    return [undefined]
}

function pkhToCashAddr(pkh) {
    const pkScript = bitbox.Script.pubKeyHash.output.encode(pkh);
    const p2pkhAddr = bitbox.Address.fromOutputScript(pkScript, network);
    return p2pkhAddr;
}

// Returns a Symbol UTXO's address
function getAddressFromSymbol(symbol) {
    const symbolHash = bitbox.Crypto.hash160(symbol);
    return pkhToCashAddr(symbolHash)
}

async function getTokensBySymbol(symbol) {
    let symbolAddress = getAddressFromSymbol(symbol)
    let utxoInfos = await getUtxosByAddress(symbolAddress)
    const tokens = [];
    for (let i in utxoInfos) {
        let utxoInfo = utxoInfos[i]
        if (utxoInfo.tx_pos !== 0) {
            continue
        }
        let tx = await getTxByTxid(utxoInfo.tx_hash); // get the detail of genesis Tx which reveals MetaInfo
        let [category, name, decimals, mintAmt, confirmations, supply] = await getMetaInfoForSymbol(tx, symbol)
        if (category !== undefined) {
            tokens.push({
                symbol: symbol,
                category: category,
                name: name,
                decimals: decimals,
                mintAmt: mintAmt,
                revealHeight: utxoInfo.height,
                revealTxid: utxoInfo.tx_hash,
                revealTxConfirmations: confirmations,
                totalSupply: supply,
            });
        }
    }
    if (tokens.size === 0) {
        return undefined
    }
    return tokens
}

export function getCategoryColorMap(tokens) {
    let categoryColorMap = {}
    let canonicalCategory = ""
    for (let token of tokens) {
        if (token.revealTxConfirmations >= 10) {
            canonicalCategory = token.category
            break
        }
    }
    for (let token of tokens) {
        if (canonicalCategory.length == 0) {
            categoryColorMap[token.category] = "yellow"
        } else if (canonicalCategory == token.category) {
            categoryColorMap[token.category] = "green"
        } else {
            categoryColorMap[token.category] = "red"
        }
    }
    return categoryColorMap
}

const goCS = `
pragma cashscript ^0.8.0;

contract GenesisOutput(pubkey recipientPK, bytes metainfo, int symbolLength) {
    function reveal(sig recipientSig) {
        require(checkSig(recipientSig, recipientPK));
        bytes20 symbolHash = hash160(metainfo.split(symbolLength)[0]);
        bytes25 outLockingBytecode = new LockingBytecodeP2PKH(symbolHash);
        require(tx.outputs[0].lockingBytecode == outLockingBytecode);
    }
}
`;

async function getCovenantAddress(recipientPK, metaInfo, symbolLen) {
    let contract = new Contract(goCS,
        [recipientPK, metaInfo, symbolLen],
        covenantNetwork
    );
    let contractAddress = contract.getDepositAddress();
    return bitbox.Address.cashToHash160(contractAddress)
}

let revealScriptHex = "537a7cad7c7f75a90376a9147c7e0288ac7e00cd87"

export async function getMetaInfoFromGenesisOutput(scriptPubkey, scriptSig) {
    let scriptPubkeyBuffer = Buffer.from(scriptPubkey, 'hex')
    if (bitbox.Script.checkP2SHOutput(scriptPubkeyBuffer) === false) {
        return undefined
    }
    let scriptPubkeyASM = bitbox.Script.toASM(scriptPubkeyBuffer)
    let scriptPubkeyItems = scriptPubkeyASM.split(" ")
    if (scriptPubkeyItems.length !== 3) {
        return undefined
    }
    let p2shAddressHash160 = scriptPubkeyItems[1]
    let scriptSigASM = bitbox.Script.toASM(Buffer.from(scriptSig, 'hex'))
    let items = scriptSigASM.split(" ")
    if (items.length !== 2) {
        return undefined
    }
    let redeemScript = items[1]
    if (redeemScript.endsWith(revealScriptHex) !== true) {
        return undefined
    }
    let redeemScriptHead = redeemScript.slice(0, -revealScriptHex.length)

    let redeemScriptHeadAsm = bitbox.Script.toASM(Buffer.from(redeemScriptHead, 'hex'))

    let all = bitbox.Script.toASM(Buffer.from(redeemScript, 'hex'))

    let params = redeemScriptHeadAsm.split(" ")
    if (params.length !== 3) {
        return undefined
    }
    if (params[2].length !== 65 * 2) {
        return undefined
    }
    let recipientPK = params[2]
    let metaInfo = params[1]
    let symbolLength
    let param0 = bitbox.Script.fromASM(params[0])
    try {
        symbolLength = bitbox.Script.decodeNumber(param0) // OP_1 ~ OP_16
    } catch (e) {
        console.log('err:', e);
        symbolLength = undefined
    }
    if (bitbox.Script.opcodes.OP_1 <= symbolLength <= bitbox.Script.opcodes.OP_16) {
        symbolLength = symbolLength - bitbox.Script.opcodes.OP_1 + 1
    } else if (symbolLength > 0) {
        // handle symbolLength > 16
        try {
            symbolLength = bitbox.Script.decodeNumber(Buffer.from(params[0], 'hex'))
        } catch (e) {
            console.log('err:', e)
            symbolLength = undefined
        }
    }
    if (symbolLength === undefined) {
        return undefined
    }
    const symbol = Buffer.from(metaInfo.slice(0, symbolLength * 2), 'hex').toString('utf8');
    const decimals = Number("0x" + metaInfo.slice(symbolLength * 2, symbolLength * 2 + 2));
    const name = Buffer.from(metaInfo.slice(symbolLength * 2 + 2), 'hex').toString('utf8');

    let pk = Uint8Array.from(Buffer.from(recipientPK, 'hex'))
    let address = await getCovenantAddress(pk, Buffer.from(metaInfo, 'hex'), symbolLength)
    if (address === p2shAddressHash160) { // Not necessary, BCH's consensus rule ensures it's true
        return { name, decimals, symbol };
    } else {
        return undefined;
    }
}

export async function queryTokenCategory(symbol, verbose = false) {
    await newClient()
    let tokens = await getTokensBySymbol(symbol)
    if (verbose) {
        console.log(tokens)
    }
    if (tokens === undefined) {
        if (verbose) {
            console.log("symbol %s is not a crc20 token", symbol)
        }
        // await electrum.close()
        return
    }
    if (verbose) {
        for (let i in tokens) {
            console.log("category:%s, name:%s, height:%d", tokens[i].category, tokens[i].name, tokens[i].revealHeight)
        }
    }
    // await electrum.close()
    return tokens;
}

export async function getTokenInfoByCategory(category) {
    await newClient()
    let tx = await getTxByTxid(category)
    let genesisOut = tx.vout[0]
    let scriptPubkeyBuffer = Buffer.from(genesisOut.scriptPubKey.hex, 'hex')
    if (bitbox.Script.checkP2SHOutput(scriptPubkeyBuffer) === false) {
        return undefined
    }
    let addresses = genesisOut.scriptPubKey.addresses
    if (addresses == undefined) {
        return undefined
    }
    let p2shAddress = addresses[0]
    let histories = await electrum.blockchain_address_getHistory(p2shAddress)
    for (let i in histories) {
        let history = histories[i]
        let tx = await getTxByTxid(history.tx_hash)
        for (let j in tx.vin) {
            if (tx.vin[j].txid == category) {
                // hit
                let [symbol, categoryParsed, name, decimals, mintAmt, confirmations, supply] = await getMetaInfoForSymbol(tx, undefined, false, category)
		if(symbol === undefined) {
			continue
		}
                if (category != categoryParsed) {
                    return undefined
                }
                return {
                    symbol: symbol,
                    category: category,
                    name: name,
                    decimals: decimals,
                    mintAmt: mintAmt,
                    revealHeight: history.height,
                    revealTxid: tx.txid,
                    revealTxConfirmations: confirmations,
                    totalSupply: supply,
                }
            }
        }
    }
}

async function test(symbol) {
    await newClient()
    let tokens = await getTokensBySymbol(symbol)
    console.log(tokens)
    if (tokens === undefined) {
        console.log("symbol %s is not a crc20 token", symbol)
        // await electrum.close()
        return
    }
    for (let i in tokens) {
        console.log("category:%s, name:%s, height:%d, supply:%d", tokens[i].category, tokens[i].name, tokens[i].revealHeight, tokens[i].totalSupply)
    }
    // await electrum.close()
}
