import * as vscode from 'vscode';
import { Connection } from "./Connection";
import { encode as msgpackEncode, decode as msgpackDecode } from "msgpack-lite";
import { WorkerError } from "./WorkerError";
import { Channel } from "ssh2";
import { diffChars } from 'diff';
import crypto = require( 'crypto' );

export const HashMatch = Symbol( 'HashMatch' );

export enum Opcode {
    LS              = 0x01,
    GET_SERVER_INFO = 0x02,
    FILE_READ       = 0x03,
    FILE_WRITE      = 0x04,
    MKDIR           = 0x05,
    DELETE          = 0x06,
    RENAME          = 0x07,
    EXPAND_PATH     = 0x08,
    FILE_WRITE_DIFF = 0x09,
    ADD_WATCH       = 0x10,
    REMOVE_WATCH    = 0x11,
}

export enum ErrorCode {
    OK      = 0,
    EPERM   = 1,    // Operation not permitted
    ENOENT  = 2,    // No such file / directory
    EIO     = 5,    // IO error
    EBADF   = 9,    // Bad file number
    EAGAIN  = 11,   // Try again
    EACCES  = 13,   // Access denied
    EBUSY   = 16,   // Device busy
    EEXIST  = 17,   // File exists
    EXDEV   = 18,   // Cross-device link
    ENODEV  = 19,   // No such device
    ENOTDIR = 20,   // Not a directory
    EISDIR  = 21,   // Is a directory
    EINVAL  = 22,   // Invalid argument
    EROFS   = 30,   // Read-only filesystem
    ERANGE  = 34,   // Out of range
    ENOSYS  = 38,   // Function not implemented
    ENODATA = 61,   // No data available
}

enum DiffAction {
    UNCHANGED = 0x00,
    INSERTED  = 0x01,
    REMOVED   = 0x02,
}

export enum ParcelType {
    // Request responses
    HEADER    = 0x01,
    BODY      = 0x02,
    ERROR     = 0x03,
    ENDOFBODY = 0x04,

    // Push notifications
    WARNING       = 0x05,
    CHANGE_NOTICE = 0x06,
}
    
const headerSizes: { [size: number]: number } = {
    0xcc: 3,
    0xcd: 4,
    0xce: 6,
    0xcf: 10,
};

interface ParcelChunk {
    [key: string]: any;
}

type ParcelConsumer = ( type: ParcelType, body: Buffer ) => boolean;
type BodyCB = ( data: Buffer ) => void;

export class PonyWorker {

    protected connection: Connection;
    private channel: Channel;
    private readBuffer : Buffer;
    private bufferMsgSize: number | undefined;
    private parcelConsumer: ParcelConsumer | undefined;

    public constructor( connection: Connection, channel: Channel ) {
        this.connection = connection;
        this.channel = channel;
        this.readBuffer = Buffer.alloc( 0 );
        this.bufferMsgSize = undefined;
        this.parcelConsumer = undefined;

        this.channel.stderr.on( 'data', this.onChannelStderr.bind( this ) );
        this.channel.on( 'data', this.onChannelData.bind( this ) );
        this.channel.on( 'error', this.onChannelError.bind( this ) );
        this.channel.on( 'end', this.onChannelEnd.bind( this ) );
    }

    public async getServerInfo(): Promise<ParcelChunk> {
        return await this.get( Opcode.GET_SERVER_INFO, {} );
    }

    public async expandPath( remotePath: string ): Promise<string> {
        const response = await this.get( Opcode.EXPAND_PATH, { path: remotePath } );
        return response.path;
    }

    public async ls( path: string ) {
        return await this.get( Opcode.LS, { path: path } );
    }

    public async readFile( remotePath: string, cachedHash?: string ): Promise<Uint8Array | Symbol> {
        const chunks: Buffer[] = [];
        const header = await this.get( Opcode.FILE_READ, { path: remotePath, cachedHash: cachedHash }, ( chunk: Buffer ) => {
            chunks.push( chunk );
        } );

        if ( header.hashMatch ) {
            return HashMatch;
        }

        return Buffer.concat( chunks );
    }

    public async writeFile( remotePath: string, data: Uint8Array, options: { create: boolean, overwrite: boolean } ) {
        return await this.get( Opcode.FILE_WRITE, {
            path: remotePath,
            data: data,
            create: options.create,
            overwrite: options.overwrite,
        } );
    }

    public async writeFileDiff( remotePath: string, originalContent: Uint8Array, updatedContent: Uint8Array ) {
        const originalString = Buffer.from( originalContent ).toString( 'binary' );
        const updatedString = Buffer.from( updatedContent ).toString( 'binary' );
        const rawDiff = diffChars( originalString, updatedString );

        // Grind up the generated diff into a flat array efficient for msgpack. 
        // Array contains pairs of elements; [ action, data, action, data, ... ]
        // - Data for INSERTED action is the data to insert,
        // - Data for REMOVED or UNCHANGED actions is the number of bytes to exclude or copy from the original.
        // Give up if diff seems to be larger than the whole file, based on approximation of msgpack'd size: 
        // - 3 bytes per diff action (1-byte action + 1-5 byte action size)
        // - Plus the total size of bytes inserted via the diff
        const diff = [];
        let approxDiffSize = rawDiff.length * 3;
        for ( const diffPiece of rawDiff ) {
            if ( diffPiece.added ) {
                diff.push( DiffAction.INSERTED );
                diff.push( diffPiece.value );
                approxDiffSize += diffPiece.value.length;
            } else if ( diffPiece.removed ) {
                diff.push( DiffAction.REMOVED );
                diff.push( diffPiece.value.length );
            } else {
                diff.push( DiffAction.UNCHANGED );
                diff.push( diffPiece.value.length );
            }

            if ( approxDiffSize > updatedContent.length ) {
                throw new Error( 'Giving up on preparing a diff; it is likely to be larger than just writing the file' );
            }
        }

        const hashBefore = crypto.createHash( 'md5' ).update( originalContent ).digest( 'hex' );
        const hashAfter = crypto.createHash( 'md5' ).update( updatedContent ).digest( 'hex' );
        
        return await this.get( Opcode.FILE_WRITE_DIFF, {
            path: remotePath,
            hashBefore,
            hashAfter,
            diff
        } );
    }

    public async rename( fromPath: string, toPath: string, options: { overwrite: boolean } ) {
        return await this.get( Opcode.RENAME, {
            from: fromPath,
            to: toPath,
            overwrite: options.overwrite,
        } );
    }

    public async delete( remotePath: string ) {
        return await this.get( Opcode.DELETE, {
            path: remotePath,
        } );
    }

    public async mkdir( remotePath: string ) {
        return await this.get( Opcode.MKDIR, {
            path: remotePath,
        } );
    }

    private onChannelData( data: Buffer ) {
        try {
            this.readBuffer = Buffer.concat( [ this.readBuffer, data ] );

            // Try to read messages in the buffer. Minimum possible parcel size is 2 bytes.
            while ( this.readBuffer.length >= 2 ) {
                // First byte defines parcel type. Make sure it looks valid.
                const parcelType = this.readBuffer[0] as ParcelType;
                if ( parcelType > ParcelType.CHANGE_NOTICE ) {
                    throw new Error( 'Invalid parcel type: ' + parcelType );
                }

                // Second byte is the start of a msgpack-formatted integer body size.
                const headerSize = headerSizes[ this.readBuffer[1] ] || 2;
                if ( this.readBuffer.length < headerSize ) {
                    break;
                }

                if ( this.bufferMsgSize === undefined ) {
                    this.bufferMsgSize = msgpackDecode( this.readBuffer.slice( 1, headerSize ) );
                }

                // Check if a whole message is ready to read.
                const totalMessageSize = headerSize + this.bufferMsgSize!;
                if ( this.readBuffer.length < totalMessageSize ) {
                    break;
                }

                const message = this.readBuffer.slice( headerSize, totalMessageSize );
                this.readBuffer = this.readBuffer.slice( totalMessageSize );
                this.bufferMsgSize = undefined;

                this.onParcel( parcelType, message );
            }
        } catch ( err ) {
            console.log( 'Error parsing channel data: ' );
            console.log( err );
            this.onChannelError( err );
        }
    }

    private processError( code: ErrorCode, message: string ): Error {
        switch ( code ) {
            case ErrorCode.EPERM:
            case ErrorCode.EACCES:
            case ErrorCode.EROFS:
                return vscode.FileSystemError.NoPermissions( message );

            case ErrorCode.ENOENT:
                return vscode.FileSystemError.FileNotFound( message );

            case ErrorCode.EEXIST:
                return vscode.FileSystemError.FileExists( message );

            case ErrorCode.EAGAIN:
            case ErrorCode.EBUSY:
            case ErrorCode.ENODEV:
                return vscode.FileSystemError.Unavailable( message );

            case ErrorCode.ENOTDIR:
                return vscode.FileSystemError.FileNotADirectory( message );

            case ErrorCode.EISDIR:
                return vscode.FileSystemError.FileIsADirectory( message );

            default:
                return new WorkerError( code, message );
        }
    }

    private async get( opcode: Opcode, args: Object, bodyCallback: BodyCB | undefined = undefined ): Promise<ParcelChunk> {
        return new Promise( ( resolve, reject ) => {
            let header: ParcelChunk | undefined = undefined;
            let bodyLength: number = 0;

            this.setParcelConsumer( ( type: ParcelType, data: Buffer ): boolean => {
                switch ( type ) {
                    case ParcelType.ERROR:
                        const details = msgpackDecode( data );
                        reject( this.processError( details.code, details.error ) );
                        return false;

                    case ParcelType.HEADER:
                        header = msgpackDecode( data );
                        if ( header && ! header.length ) {
                            // Header with no body. We're done here.
                            resolve( header! );
                            return false;
                        } else {
                            return true;
                        }

                    case ParcelType.BODY:
                        bodyLength += data.length;
                        if ( bodyCallback ) {
                            bodyCallback( data );
                        }
                        return true;

                    case ParcelType.ENDOFBODY:
                        if ( header !== undefined ) {
                            if ( bodyLength !== header.length ) {
                                console.warn( 'Warning: Header said ' + header.length + ' bytes, body was ' + bodyLength + 'bytes' );
                            }
                            resolve( header! );
                        } else {
                            reject( new Error( 'End of Body without a header' ) );
                        }
                        return false;
                    
                    default:
                        console.warn( 'Unexpected parcel type: ' + type );
                        return false;
                }
            } );

            this.sendMessage( opcode, args );
        } );
    }

    private setParcelConsumer( consumer: ParcelConsumer ) {
        if ( this.parcelConsumer !== undefined ) {
            this.onChannelError( new Error( 'Parcel consumer reset without closing previous parcel' ) );
        }

        this.parcelConsumer = consumer;
    }

    protected sendMessage( opcode: Opcode, args: any ) {
        const data = this.packMessage( opcode, args );
        this.channel.write( data );
    }

    private packMessage( opcode: Opcode, args: any ) {
        const packed = msgpackEncode( [ opcode, args ] );
        const header = msgpackEncode( packed.length );
        return Buffer.concat( [ header, packed ] );
    }

    private onChannelError( err: Error ) {
        // TODO: gracefully close channel
        console.error( err );
    }

    private onChannelStderr( data: string ) {
        console.log( 'Channel STDERR: ' + data );
    }

    private onChannelEnd() {
        // TODO: Handle graceful close. For now treat all closures as rough.
        this.onChannelError( new Error( 'Unexpected end of worker channel' ) );
    }

    protected onParcel( type: ParcelType, body: Buffer ) {
        if ( ! this.parcelConsumer ) {
            const parcelTypeName = ParcelType[ type ];
            const bodyJson = JSON.stringify( body );
            const error = new Error( 'Received parcel without a consumer waiting: ' + parcelTypeName + ' ' + bodyJson );
            return this.onChannelError( error );
        }

        const moreToReceive = this.parcelConsumer( type, body );
        if ( ! moreToReceive ) {
            this.parcelConsumer = undefined;
        }
    }

}