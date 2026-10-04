/**
 * Win32 constants and x64 record layouts for the Windows ACL sandbox backend.
 *
 * Plain ESM JavaScript on purpose: the runner entry executes in a standalone
 * node process and Node refuses TypeScript type-stripping inside node_modules,
 * where the published extension lives. Relative imports here must keep the
 * `.js` extension.
 *
 * Values are ported from deepseek-harness (MIT):
 * - packages/sandbox/sandbox-windows-acl/src/win32-abi.ts (ACL/token constants
 *   and record layouts)
 * - packages/subprocess/win32-process/src/abi.ts (process/Job/stdio constants)
 * The reference values were verified against MinGW headers by
 * packages/sandbox/sandbox-windows-acl/verify/abi-probe.cpp (printf probe plus
 * static_asserts) on the x64 ABI. Do not recompute them here.
 * @module
 */

// --- Token rights and token information classes ---

/** OpenProcess access required to query the current process token. */
export const PROCESS_QUERY_INFORMATION = 0x0400;
/** Token right required by CreateProcessAsUserW. */
export const TOKEN_ASSIGN_PRIMARY = 0x0001;
/** Token right required by DuplicateTokenEx. */
export const TOKEN_DUPLICATE = 0x0002;
/** Token right required to read token information. */
export const TOKEN_QUERY = 0x0008;
/** Token right required to replace the token default DACL. */
export const TOKEN_ADJUST_DEFAULT = 0x0080;
/** Group attribute identifying the token logon SID. */
export const SE_GROUP_LOGON_ID = 0xc0000000;
/** Group attribute marking the integrity SID of a TOKEN_MANDATORY_LABEL. */
export const SE_GROUP_INTEGRITY = 0x00000020;
/** TOKEN_INFORMATION_CLASS value for token groups. */
export const TokenGroups = 2;
/** TOKEN_INFORMATION_CLASS value for the token default DACL. */
export const TokenDefaultDacl = 6;
/** TOKEN_INFORMATION_CLASS value for the token's integrity level. */
export const TokenIntegrityLevel = 25;

// --- CreateRestrictedToken flags ---

/** CreateRestrictedToken flag that disables maximum privileges. */
export const DISABLE_MAX_PRIVILEGE = 0x1;
/** CreateRestrictedToken limited-user flag. */
export const LUA_TOKEN = 0x4;
/** Restrict write access to the listed restricting SIDs. */
export const WRITE_RESTRICTED = 0x8;

// --- File access rights and the capability grant mask ---

/** Standard-rights portion excluded from the write capability grant. */
export const STANDARD_RIGHTS_WRITE = 0x00020000;
/** Generic file write access bits. */
export const FILE_GENERIC_WRITE = 0x00120116;
/** Delete or rename an object. */
export const DELETE = 0x00010000;
/** Delete or rename a directory child. */
export const FILE_DELETE_CHILD = 0x0040;
/**
 * Capability-SID access mask granting write, delete, and child deletion.
 * WRITE_DAC and WRITE_OWNER stay excluded so a confined child cannot rewrite
 * DACLs or take ownership to escape the allowlist.
 */
export const GRANT_MASK = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE;
/** Full access used in the restricted token default DACL. */
export const FILE_ALL_ACCESS = 0x1f01ff;
/** Generic read access bit. */
export const GENERIC_READ = 0x80000000;
/** Generic write access bit. */
export const GENERIC_WRITE = 0x40000000;

// --- Well-known SIDs ---

/** WELL_KNOWN_SID_TYPE value for Everyone. */
export const WinWorldSid = 1;
/** WELL_KNOWN_SID_TYPE value for the Low mandatory level (S-1-16-4096). */
export const WinLowLabelSid = 66;

// --- ACL, ACE, and security information ---

/** SECURITY_INFORMATION flag selecting the DACL. */
export const DACL_SECURITY_INFORMATION = 0x00000004;
/** SECURITY_INFORMATION flag selecting the mandatory integrity label. */
export const LABEL_SECURITY_INFORMATION = 0x00000010;
/** SE_OBJECT_TYPE value for filesystem objects. */
export const SE_FILE_OBJECT = 1;
/** ACE type for an allowed-access entry. */
export const ACCESS_ALLOWED_ACE_TYPE = 0;
/** ACE type for a denied-access entry (shares the allowed ACE's Mask/SID layout). */
export const ACCESS_DENIED_ACE_TYPE = 1;
/** ACE type carrying a mandatory integrity label. */
export const SYSTEM_MANDATORY_LABEL_ACE_TYPE = 0x11;
/**
 * Mandatory policy denying write-class access to higher-integrity objects.
 * The kernel applies it inside the access check, so it also covers writes and
 * deletes granted through a parent directory's FILE_DELETE_CHILD right --
 * the path the write-restricted pass-2 intersection does not reach.
 */
export const SYSTEM_MANDATORY_LABEL_NO_WRITE_UP = 0x00000001;
/** ACE inheritance flags for child containers and objects. */
export const SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
/** ACE inheritance flag for child containers only (directories; files do not inherit). */
export const CONTAINER_INHERIT_ACE = 0x2;
/** ACL revision accepted by InitializeAcl and AddMandatoryAce. */
export const ACL_REVISION = 2;
/** LocalAlloc flag selecting zero-initialized fixed memory (LMEM_FIXED | LMEM_ZEROINIT). */
export const LPTR = 0x0040;
/** Maximum SID sub-authority count. */
export const SID_MAX_SUB_AUTHORITIES = 15;
/** Maximum SID allocation size in bytes. */
export const SECURITY_MAX_SID_SIZE = 68;
/** Legacy Win32 maximum path character count used by GetTempPathW. */
export const MAX_PATH = 260;

// --- TRUSTEE_W and EXPLICIT_ACCESS_W layout (x64) ---

/** TRUSTEE_TYPE value used when trustee classification is unknown. */
export const TRUSTEE_IS_UNKNOWN = 0;
/** TRUSTEE_FORM value indicating a SID pointer. */
export const TRUSTEE_IS_SID = 0;
/** Trustee record has no chained trustee. */
export const NO_MULTIPLE_TRUSTEE = 0;
/** EXPLICIT_ACCESS mode that grants access. */
export const GRANT_ACCESS = 1;
/** EXPLICIT_ACCESS mode that denies access. */
export const DENY_ACCESS = 3;
/** EXPLICIT_ACCESS mode that revokes access. */
export const REVOKE_ACCESS = 4;
/** x64 EXPLICIT_ACCESS_W byte size. */
export const EXPLICIT_ACCESS_W_SIZE = 48;
/** x64 offset of TRUSTEE_W inside EXPLICIT_ACCESS_W. */
export const TRUSTEE_W_OFFSET = 16;
/**
 * x64 offset of Trustee.ptstrName relative to the start of TRUSTEE_W (the
 * reference's convention, kept as-is to match win32-abi.ts). The absolute
 * position inside EXPLICIT_ACCESS_W -- the address the ACL layer writes the
 * trustee SID to -- is TRUSTEE_W_OFFSET + TRUSTEE_W_PTSTRNAME_OFFSET = 40.
 */
export const TRUSTEE_W_PTSTRNAME_OFFSET = 24;

// --- Token, SID_AND_ATTRIBUTES, and TOKEN_GROUPS layout (x64) ---

/** x64 SID_AND_ATTRIBUTES byte size. */
export const SID_AND_ATTRIBUTES_SIZE = 16;
/** x64 TOKEN_GROUPS offset of the first group entry. */
export const TOKEN_GROUPS_OFFSET = 8;
/** x64 TOKEN_MANDATORY_LABEL byte size (the SID is referenced, not embedded). */
export const TOKEN_MANDATORY_LABEL_SIZE = 16;
/** x64 ACL header byte size (AclRevision, Sbz1, AclSize, AceCount, Sbz2). */
export const ACL_HEADER_SIZE = 8;
/** Bytes a SYSTEM_MANDATORY_LABEL_ACE occupies beyond the ACL header and its SID. */
export const MANDATORY_ACE_OVERHEAD = 8;

// --- File open and lock constants ---

/** CreateFile share-read flag. */
export const FILE_SHARE_READ = 0x00000001;
/** CreateFile share-write flag. */
export const FILE_SHARE_WRITE = 0x00000002;
/** CreateFile disposition that opens or creates the file. */
export const OPEN_ALWAYS = 4;
/** LockFileEx exclusive-lock flag. */
export const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
/** LockFileEx immediate-failure flag. */
export const LOCKFILE_FAIL_IMMEDIATELY = 0x1;
/** Successful Win32 status code. */
export const ERROR_SUCCESS = 0;
/** Win32 error reported when an immediate byte-range lock cannot be obtained. */
export const ERROR_LOCK_VIOLATION = 33;
/** Win32 code reporting a caller-provided buffer is too small. */
export const ERROR_INSUFFICIENT_BUFFER = 122;

// --- Process, Job Object, and stdio constants (x64) ---

/** STARTUPINFOW uses the standard input, output, and error handles. */
export const STARTF_USESTDHANDLES = 0x00000100;
/** STARTUPINFOW applies wShowWindow when creating a console window. */
export const STARTF_USESHOWWINDOW = 0x00000001;
/** Initial window visibility that preserves the child's console attachment. */
export const SW_HIDE = 0;
/** HandleInformation flag that permits child inheritance. */
export const HANDLE_FLAG_INHERIT = 0x1;
/** Infinite WaitForSingleObject timeout. */
export const INFINITE = 0xffffffff;
/** CreateProcess flag that prevents user code from running before resume. */
export const CREATE_SUSPENDED = 0x4;
/** GetStdHandle selector for standard input. */
export const STD_INPUT_HANDLE = -10;
/** GetStdHandle selector for standard output. */
export const STD_OUTPUT_HANDLE = -11;
/** GetStdHandle selector for standard error. */
export const STD_ERROR_HANDLE = -12;
/** Job limit that terminates every member when the final Job handle closes. */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
/** SetInformationJobObject class for JOBOBJECT_EXTENDED_LIMIT_INFORMATION. */
export const JobObjectExtendedLimitInformation = 9;
/** x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION byte size. */
export const JOBOBJECT_EXTENDED_LIMIT_SIZE = 144;
/** Byte offset of BasicLimitInformation.LimitFlags in the extended Job record. */
export const JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET = 16;
/** x64 STARTUPINFOW byte size verified by the native probe. */
export const STARTUPINFOW_SIZE = 104;
/** x64 PROCESS_INFORMATION byte size verified by the native probe. */
export const PROCESS_INFORMATION_SIZE = 24;
