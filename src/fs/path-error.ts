export function createExistingPathError(path: string): NodeJS.ErrnoException {
  const error = new Error(`Output path already exists: ${path}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}
