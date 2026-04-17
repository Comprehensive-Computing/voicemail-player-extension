export const extensionApi = globalThis.browser ?? globalThis.chrome;

export function sendRuntimeMessage(message) {
  if (!extensionApi?.runtime?.sendMessage) {
    return Promise.reject(new Error("Extension runtime API is unavailable."));
  }

  try {
    const maybePromise = extensionApi.runtime.sendMessage(message);

    if (maybePromise && typeof maybePromise.then === "function") {
      return maybePromise;
    }
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      const lastError = globalThis.chrome?.runtime?.lastError;

      if (lastError) {
        reject(new Error(lastError.message));
        return;
      }

      resolve(response);
    });
  });
}
