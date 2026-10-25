const TEXT_APPLICATION_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"application/typescript",
	"application/x-typescript",
	"application/sql",
	"application/graphql",
	"application/yaml",
	"application/x-yaml",
	"application/toml",
	"application/x-sh",
	"application/x-httpd-php",
	"application/x-ndjson",
	"application/csv",
	"application/rtf",
]);

const BINARY_APPLICATION_TYPES = new Set([
	"application/pdf",
	"application/zip",
	"application/gzip",
	"application/x-gzip",
	"application/x-tar",
	"application/x-bzip2",
	"application/x-7z-compressed",
	"application/x-rar-compressed",
	"application/octet-stream",
	"application/wasm",
	"application/x-protobuf",
	"application/protobuf",
	"application/epub+zip",
]);

const BINARY_TYPE_PREFIXES = ["image/", "audio/", "video/", "font/", "model/"];

const HTML_SNIFF_CHARS = 1024;

/** 去掉参数、空白并转小写后的媒体类型。 */
export function mediaType(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

/** 判定媒体类型是否为二进制，判定顺序即语义，勿调整。 */
export function isBinaryContentType(contentType: string): boolean {
	const type = mediaType(contentType);
	if (type === "") return false;
	// 媒体类型必须先判定：image/svg+xml 虽以 +xml 结尾，仍是二进制
	if (BINARY_TYPE_PREFIXES.some((prefix) => type.startsWith(prefix))) return true;
	if (type.startsWith("text/")) return false;
	if (type.endsWith("+json") || type.endsWith("+xml")) return false;
	if (TEXT_APPLICATION_TYPES.has(type)) return false;
	if (BINARY_APPLICATION_TYPES.has(type)) return true;
	if (type.startsWith("application/vnd.")) return true;
	return false;
}

/** 判定媒体类型是否为 HTML 文档。 */
export function isHtmlContentType(contentType: string): boolean {
	const type = mediaType(contentType);
	return type === "text/html" || type === "application/xhtml+xml";
}

/** 判定媒体类型是否为 JSON。 */
export function isJsonContentType(contentType: string): boolean {
	const type = mediaType(contentType);
	return type === "application/json" || type === "text/json" || type.endsWith("+json");
}

/** 按正文开头粗略判定是否为完整 HTML 文档。 */
export function looksLikeHtml(body: string): boolean {
	const head = body.slice(0, HTML_SNIFF_CHARS).trimStart().toLowerCase();
	return head.startsWith("<!doctype html") || head.startsWith("<html");
}
