(function () {
  // Compatibility shim. Tokens are no longer accepted or stored by the extension.
  if (globalThis.ProjetoFichaLovableClient) {
    return;
  }

  function client() {
    if (!globalThis.ProjetoFichaMaterialApiClient) {
      throw new Error("Material API client must be loaded before the legacy adapter.");
    }
    return globalThis.ProjetoFichaMaterialApiClient;
  }

  globalThis.ProjetoFichaLovableClient = {
    collectImages: function (visualContext) {
      return client().collectImages(visualContext);
    },
    generate: function (params) {
      return client().generate(params);
    },
    parseResponse: function (data) {
      return client().parseResponse(data);
    }
  };
})();