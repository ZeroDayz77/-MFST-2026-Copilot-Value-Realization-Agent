// Azure infrastructure for the Copilot CRM backend (Path A: App Service + JS
// scoring engine — no Python at runtime). Provisions:
//   - Linux App Service Plan
//   - Node 20 Web App (system-assigned identity, HTTPS only)
//   - Key Vault holding the Azure OpenAI key, referenced from App Settings
// Bring-your-own Azure OpenAI (endpoint/deployment/key passed as parameters).
//
// Deploy:
//   az group create -n <rg> -l <location>
//   az deployment group create -g <rg> -f infra/main.bicep \
//     -p appName=<globally-unique> azureOpenAiEndpoint=https://<aoai>.openai.azure.com \
//        azureOpenAiDeployment=<deployment> azureOpenAiApiKey=<key>

@description('Base name; also the Web App name (must be globally unique).')
@minLength(3)
@maxLength(40)
param appName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('App Service plan SKU (F1 free, B1 basic, P0v3 premium).')
param sku string = 'B1'

@description('Product the CRM sells (PRODUCT_NAME app setting).')
param productName string = 'Microsoft 365 Copilot'

@description('Azure OpenAI endpoint, e.g. https://my-aoai.openai.azure.com')
param azureOpenAiEndpoint string

@description('Azure OpenAI chat deployment name, e.g. gpt-4o-mini')
param azureOpenAiDeployment string

@description('Azure OpenAI API version.')
param azureOpenAiApiVersion string = '2024-08-01-preview'

@secure()
@description('Azure OpenAI API key. Stored as a Key Vault secret, never in App Settings.')
param azureOpenAiApiKey string

var planName = '${appName}-plan'
var keyVaultName = take('${replace(toLower(appName), '-', '')}kv${uniqueString(resourceGroup().id)}', 24)
var openAiSecretName = 'AzureOpenAIApiKey'

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: {
    name: sku
  }
  properties: {
    reserved: true // Linux
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: false
    enableSoftDelete: true
    accessPolicies: []
  }
}

resource openAiSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: vault
  name: openAiSecretName
  properties: {
    value: azureOpenAiApiKey
  }
}

resource web 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'npm start'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        // We ship node_modules in the deploy package; skip Oryx remote build.
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'NODE_ENV', value: 'production' }
        // Pure-JS scoring: no Python needed at runtime.
        { name: 'SCORING_ENGINE', value: 'js' }
        { name: 'LLM_PROVIDER', value: 'azure' }
        { name: 'PRODUCT_NAME', value: productName }
        { name: 'AZURE_OPENAI_ENDPOINT', value: azureOpenAiEndpoint }
        { name: 'AZURE_OPENAI_DEPLOYMENT', value: azureOpenAiDeployment }
        { name: 'AZURE_OPENAI_API_VERSION', value: azureOpenAiApiVersion }
        // Resolved at runtime from Key Vault via the Web App's managed identity.
        { name: 'AZURE_OPENAI_API_KEY', value: '@Microsoft.KeyVault(SecretUri=${openAiSecret.properties.secretUri})' }
      ]
    }
  }
}

// Grant the Web App's managed identity read access to the vault's secrets.
// Added as a separate access policy to avoid a circular dependency with the app.
resource vaultAccess 'Microsoft.KeyVault/vaults/accessPolicies@2023-07-01' = {
  parent: vault
  name: 'add'
  properties: {
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: web.identity.principalId
        permissions: {
          secrets: [ 'get' ]
        }
      }
    ]
  }
}

output webAppName string = web.name
output webAppUrl string = 'https://${web.properties.defaultHostName}'
output keyVaultName string = vault.name
