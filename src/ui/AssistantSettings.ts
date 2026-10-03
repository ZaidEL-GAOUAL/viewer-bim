import type { ApiSettings } from '../assistant/client.ts';
import { normalizeApiSettings } from '../assistant/settings.ts';
import { button, h } from './dom.ts';

/** Session-only BYOK settings. The existing backend remains responsible for calling the LLM. */
export class AssistantSettings {
  readonly el: HTMLDetailsElement;
  private readonly fields: HTMLFieldSetElement;

  constructor(onChange: (settings: ApiSettings | null) => void) {
    const presets = [
      ['OpenAI', 'https://api.openai.com/v1'],
      ['Groq', 'https://api.groq.com/openai/v1'],
      ['Cerebras', 'https://api.cerebras.ai/v1'],
      ['Autre API compatible', ''],
    ];
    const preset = h('select', { attrs: { 'aria-label': 'Fournisseur de mon API' } },
      ...presets.map(([name, endpoint]) => h('option', { text: name, attrs: { value: endpoint } })));
    const endpoint = h('input', { attrs: { type: 'url', value: presets[0][1], placeholder: 'https://api.exemple.fr/v1', 'aria-label': 'Adresse de mon API', autocomplete: 'off', spellcheck: 'false' } });
    const model = h('input', { attrs: { type: 'text', placeholder: 'Nom du modèle', 'aria-label': 'Modèle de mon API', autocomplete: 'off', spellcheck: 'false', maxlength: '200' } });
    const key = h('input', { attrs: { type: 'password', placeholder: 'Clé API', 'aria-label': 'Clé de mon API', autocomplete: 'off', spellcheck: 'false', maxlength: '8192' } });
    const status = h('p', { class: 'assistant-api-status', text: 'Le service du site est actif.', attrs: { role: 'status' } });
    preset.addEventListener('change', () => { endpoint.value = preset.value; });
    const field = (label: string, input: HTMLElement) => h('label', { class: 'assistant-api-field' }, h('span', { text: label }), input);
    this.fields = h('fieldset', { class: 'assistant-api-fields' },
      field('Fournisseur', preset), field('Adresse de base ou /chat/completions', endpoint), field('Modèle', model), field('Clé API', key),
      h('div', { class: 'assistant-api-actions' },
        button('Utiliser mon API', () => {
          try {
            const settings = normalizeApiSettings(endpoint.value, key.value, model.value);
            onChange(settings);
            status.textContent = `Mon API est active : ${new URL(settings.endpoint).hostname} · ${settings.model}`;
            status.classList.remove('error');
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : 'Configuration invalide.';
            status.classList.add('error');
          }
        }),
        button('Service du site', () => { key.value = ''; onChange(null); status.textContent = 'Le service du site est actif. La clé a été effacée.'; status.classList.remove('error'); })),
      status,
      h('p', { class: 'hint', text: 'Clé gardée uniquement dans cet onglet et transmise au relais pour chaque demande. Une adresse d’entreprise doit être autorisée par l’administrateur du relais.' }));
    this.el = h('details', { class: 'assistant-api-settings' }, h('summary', { text: 'Paramètres de l’API' }), this.fields);
  }

  setBusy(busy: boolean): void { this.fields.disabled = busy; }
}
