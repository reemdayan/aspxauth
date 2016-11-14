import assert from "assert";
import crypto from "crypto";
import BufferReader from "./buffer-reader";
import BufferWriter from "./buffer-writer";

const VALIDATION_METHODS = {
	sha1: {
		algorithm: "sha1",
		signatureSize: 20
	}
};

const DECRYPTION_METHODS = {
	aes: {
		cipher: "aes-256-cbc",
		ivSize: 16,
		headerSize: 32
	}
};

const FORMAT_VERSION = 1;
const SPACER = 0xfe;
const FOOTER = 0xff;

/**
	validationMethod (string): (default "sha1")
	validationKey (string): hex encoded key to use for signature validation

	decryptionMethod (string): (default "aes")
	decryptionIV (string): hex encoded initialization vector (defaults to zeros)
	decryptionKey (string): hex encoded key to use for decryption

	ticketVersion (integer): if specified then will be used to validate the ticket version
	validateExpiration (bool): (default true) if false then decrypted tickets will be returned even if past their expiration

	generateAsBuffer (bool): (default false) if true, generate will return a buffer rather than a hex encoded string
	defaultTTL (integer): (default 24hrs) if provided is used as milliseconds from issueDate to expire generated tickets
	defaultPersistent (bool): (default false) if provided is used as default isPersistent value for generated tickets
	defaultCookiePath (string): (default "/") if provided is used as default cookie path for generated tickets
 */

export default config => {
	const VALIDATION_METHOD = VALIDATION_METHODS[ config.validationMethod || "sha1" ];
	const DECRYPTION_METHOD = DECRYPTION_METHODS[ config.decryptionMethod || "aes" ];

	assert( VALIDATION_METHOD, "Invalid validation method" );
	assert( DECRYPTION_METHOD, "Invalid decryption method" );
	assert( config.validationKey, "'validationKey' is required" );
	assert( config.decryptionKey, "'decryptionKey' is required" );

	const VALIDATION_KEY = new Buffer( config.validationKey, "hex" );
	const DECRYPTION_KEY = new Buffer( config.decryptionKey, "hex" );
	const DECRYPTION_IV = config.decryptionIV ? new Buffer( config.decryptionIV, "hex" ) : Buffer.alloc( DECRYPTION_METHOD.ivSize );

	const REQUIRED_VERSION = config.ticketVersion || false;
	const VALIDATE_EXPIRATION = config.validateExpiration !== false;

	const AS_BUFFER = !!config.generateAsBuffer;
	const DEFAULT_TTL = config.defaultTTL || 86400000;
	const DEFAULT_IS_PERSISTENT = !!config.defaultPersistent;
	const DEFAULT_COOKIE_PATH = config.defaultCookiePath || "/";

	const BASE_PAYLOAD_SIZE = DECRYPTION_METHOD.headerSize + 21;

	function validate( bytes ) {
		const signature = bytes.slice( -VALIDATION_METHOD.signatureSize );
		const payload = bytes.slice( 0, -VALIDATION_METHOD.signatureSize );

		const hash = crypto.createHmac( VALIDATION_METHOD.algorithm, VALIDATION_KEY );
		hash.update( payload );

		return hash.digest().equals( signature );
	}

	function decrypt( cookie ) {
		try {
			const bytes = cookie instanceof Buffer ? cookie : new Buffer( cookie, "hex" );

			if ( !validate( bytes ) ) {
				return null;
			}

			const decryptor = crypto.createDecipheriv( DECRYPTION_METHOD.cipher, DECRYPTION_KEY, DECRYPTION_IV );
			const payload = bytes.slice( 0, -VALIDATION_METHOD.signatureSize );
			const decryptedBytes = Buffer.concat( [ decryptor.update( payload ), decryptor.final() ] );
			const reader = new BufferReader( decryptedBytes );
			const ticket = {};

			reader.skip( DECRYPTION_METHOD.headerSize );
			reader.assertByte( FORMAT_VERSION, "format version" );

			if ( REQUIRED_VERSION ) {
				reader.assertByte( REQUIRED_VERSION, "ticket version" );
				ticket.ticketVersion = REQUIRED_VERSION;
			} else {
				ticket.ticketVersion = reader.readByte();
			}

			ticket.issueDate = reader.readDate();
			reader.assertByte( SPACER, "spacer" );
			ticket.expirationDate = reader.readDate();

			if ( VALIDATE_EXPIRATION && ticket.expirationDate < Date.now() ) {
				return null;
			}

			ticket.isPersistent = reader.readBool();
			ticket.name = reader.readString();
			ticket.customData = reader.readString();
			ticket.cookiePath = reader.readString();
			reader.assertByte( FOOTER, "footer" );

			return ticket;
		} catch ( e ) {
			return null;
		}
	}

	function generate( ticket ) {
		const stringsSize = BufferWriter.stringSize( ticket.name ) + BufferWriter.stringSize( ticket.customData ) + BufferWriter.stringSize( ticket.cookiePath || DEFAULT_COOKIE_PATH );
		const writer = new BufferWriter( BASE_PAYLOAD_SIZE + stringsSize );

		// Write a random header to serve as a salt
		writer.writeBuffer( crypto.randomBytes( DECRYPTION_METHOD.headerSize ) );
		writer.writeByte( FORMAT_VERSION );

		if ( REQUIRED_VERSION ) {
			if ( ticket.ticketVersion ) {
				assert( REQUIRED_VERSION === ticket.ticketVersion, `Invalid ticket version ${ ticket.ticketVersion }, expected ${ REQUIRED_VERSION }` );
			}
			writer.writeByte( REQUIRED_VERSION );
		} else {
			writer.writeByte( ticket.ticketVersion || 0x01 );
		}

		const issueDate = ticket.issueDate || new Date();
		const expirationDate = ticket.expirationDate || new Date( issueDate.getTime() + DEFAULT_TTL );
		writer.writeDate( issueDate );
		writer.writeByte( SPACER );
		writer.writeDate( expirationDate );
		writer.writeBool( "isPersistent" in ticket ? !!ticket.isPersistent : DEFAULT_IS_PERSISTENT );
		writer.writeString( ticket.name );
		writer.writeString( ticket.customData );
		writer.writeString( ticket.cookiePath || DEFAULT_COOKIE_PATH );
		writer.writeByte( FOOTER );

		const encryptor = crypto.createCipheriv( DECRYPTION_METHOD.cipher, DECRYPTION_KEY, DECRYPTION_IV );
		const encryptedBytes = Buffer.concat( [ encryptor.update( writer.buffer ), encryptor.final() ] );

		const hash = crypto.createHmac( "sha1", VALIDATION_KEY );
		hash.update( encryptedBytes );

		const final = Buffer.concat( [ encryptedBytes, hash.digest() ] );

		return AS_BUFFER ? final : final.toString( "hex" );
	}

	return { decrypt, generate };
};
