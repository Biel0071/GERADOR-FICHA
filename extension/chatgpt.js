(function () {
  if (globalThis.ProjetoFichaChatGPT) {
    return;
  }

  const C = globalThis.ProjetoFichaConstants;
  const Engine = globalThis.ProjetoFichaChatGPTAutomationEngine;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || (
      message.type !== C.MESSAGE_TYPES.CHATGPT_RUN &&
      message.type !== C.MESSAGE_TYPES.CHATGPT_AUTOMATION_TEST_RUN &&
      message.type !== C.MESSAGE_TYPES.CHATGPT_INSPECT_RUN
    )) {
      return false;
    }

    const runner = message.type === C.MESSAGE_TYPES.CHATGPT_AUTOMATION_TEST_RUN
      ? Engine.runAutomationTest
      : message.type === C.MESSAGE_TYPES.CHATGPT_INSPECT_RUN
        ? Engine.inspectChatGPTPage
        : Engine.runAutomation;

    runner(message.payload || {})
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          manualFallback: false,
          answer: "",
          message: error.message || "Falha ao automatizar o ChatGPT."
        });
      });

    return true;
  });

  globalThis.ProjetoFichaChatGPT = {
    runAutomation: Engine.runAutomation,
    runAutomationTest: Engine.runAutomationTest,
    inspectChatGPTPage: Engine.inspectChatGPTPage,
    waitForProjectReady: Engine.waitForProjectReady
  };
})();
