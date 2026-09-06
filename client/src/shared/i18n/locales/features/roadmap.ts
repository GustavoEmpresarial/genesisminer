/**
 * Public roadmap chrome labels — merged into catalogs as `roadmap`.
 * Step title/description come from the API and are not translated here.
 */
import type { MessageTree } from '../../types';

export const roadmapEn: MessageTree = {
  title: 'Genesis Roadmap',
  subtitle: 'Timeline of upcoming deliveries and updates.',
  empty: 'The roadmap will be published soon.',
  forecast: 'Forecast: {{date}}',
  stepOf: 'Step {{current}} of {{total}}',
  imageFallback: 'Image',
  status: {
    planned: 'Planned',
    in_dev: 'In Development',
    testing: 'In Testing',
    done: 'Completed',
    cancelled: 'Cancelled'
  }
};

export const roadmapPt: MessageTree = {
  title: 'Roadmap Genesis',
  subtitle: 'Linha do tempo das próximas entregas e atualizações.',
  empty: 'O roadmap será publicado em breve.',
  forecast: 'Previsão: {{date}}',
  stepOf: 'Etapa {{current}} de {{total}}',
  imageFallback: 'Imagem',
  status: {
    planned: 'Planejado',
    in_dev: 'Em Desenvolvimento',
    testing: 'Em Testes',
    done: 'Concluído',
    cancelled: 'Cancelado'
  }
};

export const roadmapEs: MessageTree = {
  title: 'Roadmap Genesis',
  subtitle: 'Línea de tiempo de próximas entregas y actualizaciones.',
  empty: 'El roadmap se publicará pronto.',
  forecast: 'Previsión: {{date}}',
  stepOf: 'Etapa {{current}} de {{total}}',
  imageFallback: 'Imagen',
  status: {
    planned: 'Planificado',
    in_dev: 'En desarrollo',
    testing: 'En pruebas',
    done: 'Completado',
    cancelled: 'Cancelado'
  }
};
