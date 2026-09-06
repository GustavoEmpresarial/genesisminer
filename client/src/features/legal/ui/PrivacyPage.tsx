import React from 'react';
import { ShieldCheck } from 'lucide-react';

const sections = [
  {
    id: 'responsavel',
    title: '1. Responsável pelo tratamento, contactos e âmbito',
    body: [
      'Esta Política de Privacidade descreve como o Genesis Miner trata dados pessoais quando você visita o site, utiliza a aplicação web, cria conta, associa carteira, participa em mecânicas de jogo, recompensas, indicações ou contacta o suporte.',
      'O responsável pelo tratamento dos dados pessoais processados através da plataforma é a entidade operacional identificada nas páginas legais, institucionais ou de transparência do Genesis Miner. Questões relacionadas com privacidade devem ser encaminhadas pelos canais oficiais de suporte publicados na própria plataforma.',
      'Esta política aplica-se ao tratamento relacionado com o site, áreas autenticadas, APIs, suporte ao cliente, operações de segurança, prevenção a fraude, comunicações operacionais, marketing quando utilizado e integrações com fornecedores de carteira, pagamentos, analytics, cloud e infraestrutura.',
      'Dependendo da jurisdição aplicável, determinados anexos, avisos complementares ou consentimentos adicionais podem coexistir com esta política para temas específicos.'
    ]
  },
  {
    id: 'definicoes',
    title: '2. Definições e papéis',
    body: [
      '“Dados pessoais” significa informação relativa a uma pessoa singular identificada ou identificável. “Tratamento” inclui recolha, armazenamento, uso, organização, divulgação, limitação, eliminação e operações semelhantes.',
      '“Você” significa visitantes, utilizadores registados e pessoas que interagem com o Genesis Miner. Quando atuarmos como subcontratante de terceiros em contexto específico, termos contratuais próprios poderão aplicar-se, mas esta política descreve principalmente as práticas do Genesis Miner como responsável pelo produto.',
      '“Fornecedor” ou “terceiro” pode incluir prestadores de alojamento, infraestrutura, monitorização, blockchain, comunicação, analytics, pagamentos, suporte e ferramentas de segurança.'
    ]
  },
  {
    id: 'categorias',
    title: '3. Categorias de dados pessoais que tratamos',
    body: [
      'Podemos tratar dados de conta e perfil, como nome de utilizador, e-mail, hash de palavra-passe, códigos de indicação, preferências e informações de perfil.',
      'Também podemos tratar dados de segurança e sessão, como identificadores de sessão, endereço IP, carimbos de data e hora, metadados de dispositivo e navegador, sinais antifraude, auditoria e localização aproximada derivada do IP.',
      'No contexto do jogo e da economia interna, podemos tratar saldos, inventário, recompensas, métricas de mineração simulada, hashrate, histórico de eventos, registos operacionais da conta e atividade relacionada com funcionalidades do produto.',
      'Quando você liga uma carteira, podemos tratar endereços públicos, identificadores de rede, referências de transações relacionadas com depósitos ou saques e resultados de triagem de risco. Não armazenamos chaves privadas nem frases-semente.',
      'Se contactar o suporte, podemos tratar mensagens, anexos, histórico de atendimento e informações fornecidas voluntariamente.',
      'Em determinadas circunstâncias, também poderemos tratar dados derivados, inferências de risco, padrões de comportamento, métricas antifraude e histórico de ações administrativas ou de segurança relacionadas com a conta.'
    ]
  },
  {
    id: 'finalidades',
    title: '4. Finalidades e bases legais',
    body: [
      'Quando o RGPD, o UK GDPR, a LGPD ou legislação semelhante se aplica, podemos tratar dados com base em execução de contrato, interesses legítimos, cumprimento de obrigação legal, prevenção a fraude e consentimento quando necessário.',
      'Tratamos dados para criar e manter contas, autenticar utilizadores, operar o jogo, gerir saldo e inventário, processar pedidos de suporte, aplicar regras internas, proteger a plataforma, cumprir obrigações legais e melhorar a experiência do produto.',
      'Podemos enviar mensagens de serviço e segurança sem depender de consentimento de marketing quando a lei assim permitir. Comunicações promocionais ou campanhas opcionais serão tratadas segundo base legal apropriada e mecanismos de cancelamento quando aplicáveis.',
      'Quando múltiplas bases legais forem potencialmente aplicáveis à mesma operação, o Genesis Miner poderá fundamentar o tratamento na base mais adequada ao contexto concreto.'
    ]
  },
  {
    id: 'cookies',
    title: '5. Cookies, armazenamento local e tecnologias semelhantes',
    body: [
      'Utilizamos cookies, armazenamento local e tecnologias semelhantes para manter sessões, proteger contra abuso, memorizar preferências, melhorar desempenho e suportar funcionalidades essenciais da aplicação.',
      'Cookies estritamente necessários podem ser utilizados sem consentimento quando indispensáveis à prestação segura do serviço. Se implementarmos cookies analíticos ou publicitários não essenciais em cenários regulados, disponibilizaremos mecanismo adequado de consentimento quando exigido por lei.',
      'A desativação de tecnologias necessárias pode impedir login, segurança de sessão ou funcionamento normal da plataforma.',
      'Mais detalhes sobre este tema podem constar da Política de Cookies do Genesis Miner.'
    ]
  },
  {
    id: 'carteira-blockchain',
    title: '6. Dados de carteira, transparência blockchain e redes de terceiros',
    body: [
      'Blockchains públicas não são controladas pelo Genesis Miner. Endereços e transações difundidos on-chain podem tornar-se públicos de forma permanente e ser tratados por validadores, indexadores, exploradores, fornecedores de analytics e outras entidades independentes.',
      'Nunca solicitamos frases-semente nem chaves privadas. Você não deve partilhar esse tipo de informação com ninguém, mesmo que alegue ser suporte.',
      'Você é responsável por verificar rede, token, carteira e endereço antes de realizar qualquer operação on-chain.'
    ]
  },
  {
    id: 'criancas',
    title: '7. Crianças e menores',
    body: [
      'O Genesis Miner não é dirigido a crianças abaixo da idade mínima exigida para consentimento ou contratação na jurisdição aplicável.',
      'Não recolhemos conscientemente dados de menores abaixo dessa idade. Se soubermos que tais dados foram fornecidos indevidamente, poderemos restringir o tratamento, solicitar validação adicional ou eliminar as informações conforme a lei.'
    ]
  },
  {
    id: 'origens',
    title: '8. Origens dos dados pessoais',
    body: [
      'Recolhemos dados diretamente de você, automaticamente a partir do uso da plataforma e, quando necessário, de fornecedores ou parceiros relacionados com segurança, verificação, infraestrutura, analytics, carteiras ou pagamentos.',
      'A origem dos dados depende da forma como você utiliza os serviços.',
      'Quando informações são obtidas de terceiros, o seu uso permanece sujeito às finalidades legítimas descritas nesta política e às restrições legais aplicáveis.'
    ]
  },
  {
    id: 'destinatarios',
    title: '9. Destinatários, subcontratantes e transferências subsequentes',
    body: [
      'Podemos partilhar dados pessoais com fornecedores de alojamento, cloud, e-mail, notificações, segurança, monitorização, suporte, analytics, pagamentos, infraestrutura blockchain, consultores e autoridades quando exigido por lei ou necessário para operação do serviço.',
      'Sempre que aplicável, utilizamos medidas contratuais razoáveis para exigir confidencialidade, segurança e uso compatível com as finalidades autorizadas.',
      'O nível de controlo sobre o destinatário depende da natureza da relação com esse terceiro, do enquadramento legal e da infraestrutura envolvida.'
    ]
  },
  {
    id: 'transferencias-internacionais',
    title: '10. Transferências internacionais',
    body: [
      'Os seus dados podem ser tratados ou armazenados fora do seu país de residência. Quando exigido por lei, procuramos adotar salvaguardas adequadas para transferências internacionais, incluindo mecanismos contratuais e organizacionais reconhecidos pela legislação aplicável.',
      'A utilização de fornecedores globais de cloud, e-mail, monitorização ou blockchain pode implicar circulação internacional de dados em múltiplas jurisdições.'
    ]
  },
  {
    id: 'conservacao-seguranca',
    title: '11. Conservação e segurança',
    body: [
      'Conservamos dados pessoais apenas pelo tempo necessário para cumprir as finalidades descritas nesta política, respeitar obrigações legais, resolver litígios, manter segurança, investigar fraude e suportar operações técnicas e cópias de segurança.',
      'Aplicamos medidas administrativas, técnicas e organizacionais razoáveis para proteger dados pessoais, incluindo controlo de acesso, separação de ambientes, registos, monitorização, encriptação em trânsito quando apropriado e revisão de vulnerabilidades. Nenhum sistema é absolutamente invulnerável.',
      'Períodos específicos de retenção podem variar por categoria de dado, necessidade operacional, obrigação legal, histórico de conta, requisitos de auditoria e presença de litígios ou investigações em curso.'
    ]
  },
  {
    id: 'violacoes-decisao-automatizada',
    title: '12. Violações de dados e decisões automatizadas',
    body: [
      'Mantemos procedimentos internos para deteção, avaliação e resposta a incidentes de segurança e, quando exigido por lei, para notificação de violações de dados pessoais a autoridades competentes e titulares afetados.',
      'Podemos usar mecanismos automatizados para pontuação de risco, deteção de abuso, antifraude, segurança de conta e priorização operacional. Quando a lei exigir, disponibilizaremos informação adicional sobre lógica aplicada, relevância e revisão humana.',
      'Nem toda decisão interna será exclusivamente automatizada no sentido jurídico estrito, mas ferramentas automatizadas podem influenciar revisões, alertas, triagem e medidas temporárias de proteção.'
    ]
  },
  {
    id: 'direitos',
    title: '13. Os seus direitos de privacidade',
    body: [
      'Dependendo da sua jurisdição, você pode ter direitos de acesso, confirmação de tratamento, correção, atualização, oposição, limitação, anonimização, bloqueio, portabilidade, eliminação, retirada de consentimento e informação sobre decisões automatizadas.',
      'Pedidos de privacidade devem ser enviados pelos canais oficiais de suporte com informação suficiente para confirmar identidade e localização do pedido. Podemos solicitar dados adicionais para evitar fraude ou pedidos abusivos.',
      'O exercício de direitos pode ser limitado quando existir fundamento legal para retenção, obrigação regulatória, necessidade de defesa de direitos, proteção de terceiros ou prevenção de fraude.'
    ]
  },
  {
    id: 'marketing-dnt',
    title: '14. Preferências de marketing e Do Not Track',
    body: [
      'Você pode cancelar comunicações de marketing usando mecanismos disponibilizados nas mensagens ou pelos canais oficiais de suporte, quando aplicável.',
      'Salvo obrigação legal específica, o Genesis Miner pode não responder de forma uniforme a sinais “Do Not Track”, dada a ausência de um padrão técnico único e universalmente vinculativo.',
      'Mensagens estritamente operacionais, de segurança ou de serviço podem continuar a ser enviadas quando necessárias para a conta ou para cumprimento de obrigações legais.'
    ]
  },
  {
    id: 'alteracoes-contacto',
    title: '15. Alterações, reclamações e contacto',
    body: [
      'Podemos atualizar esta Política de Privacidade publicando uma versão revista e atualizando a data de “Última atualização”. Quando exigido por lei, poderemos fornecer aviso adicional ou recolher novo consentimento.',
      'Pode apresentar pedidos, dúvidas e reclamações pelos canais oficiais de suporte do Genesis Miner. Quando aplicável, também poderá contactar a autoridade de proteção de dados competente na sua jurisdição.',
      'Recomendamos que qualquer questão seja primeiro encaminhada ao Genesis Miner para tentativa de esclarecimento e resolução operacional em prazo razoável.'
    ]
  }
];

export const PrivacyPage: React.FC = () => {
  return (
    <div className="max-w-5xl mx-auto px-6 py-12 text-slate-700 dark:text-slate-300 animate-in slide-in-from-bottom-4 duration-500">
      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-4 flex items-center justify-center gap-3">
          <ShieldCheck className="text-emerald-600 dark:text-emerald-500" /> Política de Privacidade
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-lg">
          Esta política descreve como o Genesis Miner trata dados pessoais quando você utiliza o site, a aplicação e os serviços relacionados.
        </p>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-500">Última atualização: 21 de maio de 2026</p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 shadow-sm mb-8">
        <p className="text-sm md:text-base leading-7">
          Esta Política de Privacidade visa dar transparência sobre tratamento de dados pessoais em linha com boas práticas e requisitos legais aplicáveis, incluindo, quando relevantes, RGPD, UK GDPR, LGPD e normas estaduais dos Estados Unidos.
        </p>
      </div>

      <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 mb-10">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">Nesta página</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="text-emerald-700 dark:text-emerald-400 hover:text-emerald-600 dark:hover:text-emerald-300 transition-colors"
            >
              {section.title}
            </a>
          ))}
        </div>
      </div>

      <div className="space-y-8">
        {sections.map((section) => (
          <section
            key={section.id}
            id={section.id}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 shadow-sm"
          >
            <h2 className="text-2xl font-bold text-slate-900 dark:text-white mb-4">{section.title}</h2>
            <div className="space-y-4">
              {section.body.map((paragraph, idx) => (
                <p key={idx} className="text-sm md:text-base leading-7 text-slate-600 dark:text-slate-300">
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
