import React from 'react';
import { FileText } from 'lucide-react';

const sections = [
  {
    id: 'disposicoes-gerais',
    title: '1. Disposições gerais',
    body: [
      'Ao usar o Genesis Miner e os serviços relacionados, você confirma que leu estes Termos de Uso e a nossa Política de Privacidade, compreendeu o seu conteúdo e concorda em ficar vinculado a eles.',
      'Este acordo regula a relação entre o utilizador da plataforma ("Usuário") e o operador dos serviços ("Administração", "nós", "nosso"). O Genesis Miner é um projeto de jogo e simulação com elementos Web3 e não deve ser tratado como plataforma de investimento, instrumento financeiro, promessa de lucro garantido, emprego ou software de mineração real em redes blockchain externas.',
      'Você declara que atingiu a maioridade na sua jurisdição e que é o único responsável por garantir que o uso da plataforma é lícito no local onde se encontra. Também é responsável por proteger a sua conta, o seu e-mail e a sua palavra-passe.',
      'Reservamo-nos o direito de recusar serviço, solicitar verificações adicionais, suspender funcionalidades, bloquear contas, ajustar regras económicas do jogo, recompensas, itens virtuais, saldos internos e parâmetros operacionais quando necessário para segurança, conformidade, equilíbrio económico ou prevenção de fraude.',
      'Se você não concordar com estes Termos ou com políticas relacionadas publicadas pelo Genesis Miner, deve interromper o uso da plataforma e das suas funcionalidades.'
    ]
  },
  {
    id: 'uso-dos-servicos',
    title: '2. Uso dos serviços e regras de conduta',
    body: [
      'Os serviços destinam-se a entretenimento pessoal e uso não comercial, salvo autorização expressa por escrito. Você não deve vender, alugar, comprar ou transferir contas, automatizar interações com bots, scripts ou software não autorizado, praticar scraping em larga escala, fazer engenharia reversa, contornar limitações técnicas, usar cheats, hacks ou explorar falhas.',
      'É proibido violar leis aplicáveis, tentar acesso não autorizado, interferir com os sistemas, distribuir malware, praticar phishing, recolher credenciais, assediar outros utilizadores, fazer spam, manipular o suporte, abusar do sistema de denúncias ou praticar fraude em qualquer mecânica da plataforma.',
      'Podemos suspender, encerrar contas, remover conteúdo, reverter ganhos indevidos, congelar recursos ou impedir saques quando entendermos, a nosso exclusivo critério, que a conduta foi abusiva, ilícita, fraudulenta ou contrária ao espírito do Genesis Miner.',
      'O facto de determinada conduta não estar expressamente listada nestes Termos não impede que seja tratada como proibida se comprometer segurança, estabilidade, integridade económica ou operação regular do produto.'
    ]
  },
  {
    id: 'dados-pessoais',
    title: '3. Dados pessoais, marketing e cookies',
    body: [
      'Ao usar o Genesis Miner, você concorda com a recolha, utilização, armazenamento e tratamento de dados pessoais conforme descrito na Política de Privacidade.',
      'Esses dados podem ser usados para operar os serviços, melhorar a plataforma, proteger contas, prevenir fraude, cumprir obrigações legais e, quando permitido, enviar comunicações de marketing e serviço. Você poderá retirar consentimentos de marketing quando aplicável pelos meios disponibilizados.',
      'O uso dos serviços implica também o tratamento de dados técnicos, operacionais e de segurança necessários para autenticação, funcionamento do jogo, prevenção de abuso e manutenção da infraestrutura.'
    ]
  },
  {
    id: 'contas-inativas',
    title: '4. Contas inativas',
    body: [
      'Podemos aplicar políticas administrativas a contas inativas por longos períodos, incluindo medidas operacionais, revisão de estado, encerramento ou outras ações permitidas por lei.',
      'Caso políticas específicas de inatividade venham a exigir aviso, faremos esforços razoáveis para comunicar por e-mail, mensagem na aplicação ou aviso publicado na própria plataforma.'
    ]
  },
  {
    id: 'padroes-de-conteudo',
    title: '5. Padrões de conteúdo',
    body: [
      'Você não pode criar, partilhar ou publicar material ilegal, ameaçador, difamatório, obsceno, discriminatório, violento, enganoso ou de qualquer forma incompatível com a segurança da comunidade.',
      'Também é proibido usar o Genesis Miner para assédio, spam, publicidade não solicitada, concursos não autorizados ou qualquer conteúdo que coloque utilizadores, parceiros ou a plataforma em risco.'
    ]
  },
  {
    id: 'monitorizacao',
    title: '6. Monitorização e moderação',
    body: [
      'Não somos obrigados a monitorizar todo o conteúdo gerado por utilizadores, mas podemos rever, moderar, remover conteúdo, rejeitar nomes de utilizador e tomar medidas de aplicação quando necessário para segurança, integridade do produto, cumprimento legal e operacionalidade do serviço.',
      'Opiniões, comentários, mensagens e materiais publicados por utilizadores são da responsabilidade exclusiva de quem os enviou.',
      'A ausência de remoção imediata de determinado conteúdo não significa aceitação, licitude, concordância ou renúncia ao direito de moderar posteriormente.'
    ]
  },
  {
    id: 'sem-aconselhamento',
    title: '7. Sem aconselhamento de investimento, fiscal ou jurídico',
    body: [
      'O Genesis Miner não fornece aconselhamento de investimento, financeiro, fiscal, jurídico ou regulatório. Todo o conteúdo da plataforma tem finalidade informativa, recreativa ou operacional dentro do jogo.',
      'Nada no Genesis Miner constitui recomendação para comprar, vender, manter ou movimentar ativos digitais, nem garantia de valorização, rendimento, retorno económico ou comportamento futuro de mercado.'
    ]
  },
  {
    id: 'garantias-e-indemnizacao',
    title: '8. Garantias do utilizador e indemnização',
    body: [
      'Você declara que não utilizará o Genesis Miner para fins ilícitos, incluindo lavagem de dinheiro, fraude, evasão de sanções, corrupção, financiamento ilícito ou qualquer atividade proibida por lei.',
      'Na máxima extensão permitida pela legislação aplicável, você concorda em indemnizar e isentar o Genesis Miner, os seus responsáveis, colaboradores e afiliados por reclamações, danos, custos e despesas decorrentes da sua violação destes Termos, do seu conteúdo ou da violação de direitos de terceiros.',
      'Essa indemnização pode incluir custos razoáveis de resposta, investigação, defesa e mitigação associados à conduta indevida do utilizador.'
    ]
  },
  {
    id: 'propriedade-intelectual',
    title: '9. Propriedade intelectual',
    body: [
      'Os materiais, marcas, nomes, logótipos, interfaces, textos, imagens, código e demais ativos da plataforma pertencem ao Genesis Miner ou são usados sob licença, estando protegidos por legislação aplicável.',
      'Você não adquire qualquer direito de titularidade sobre a plataforma, os seus materiais ou os seus elementos visuais, além do direito limitado de uso pessoal segundo estes Termos.',
      'É proibido reproduzir, redistribuir, publicar, adaptar, clonar ou explorar economicamente materiais protegidos do Genesis Miner sem autorização prévia e expressa.'
    ]
  },
  {
    id: 'limitacao-de-responsabilidade',
    title: '10. Limitação de responsabilidade',
    body: [
      'Na máxima extensão permitida pela lei, o Genesis Miner não será responsável por perdas, danos indiretos, lucros cessantes, perda de dados, reputação, interrupções de serviço, indisponibilidade, eventos de força maior, falhas de terceiros, falhas de rede, volatilidade de ativos digitais ou uso indevido da sua conta.',
      'Saldos, hashrate, itens, recompensas, moedas internas, estimativas e valores exibidos na plataforma são regidos pelas regras do servidor e não equivalem, por si só, a saldo bancário, investimento ou promessa de valor económico resgatável até que um saque seja processado com sucesso segundo as regras aplicáveis.',
      'Na medida permitida por lei, eventuais responsabilidades diretas do Genesis Miner relacionadas com o serviço ficam limitadas ao montante efetivamente pago pelo utilizador diretamente ao Genesis Miner na operação específica que originou a reclamação, quando esse limite for juridicamente admissível.'
    ]
  },
  {
    id: 'riscos-cripto',
    title: '11. Riscos de cripto e restrições geográficas',
    body: [
      'Ativos digitais são voláteis, experimentais e podem estar sujeitos a mudanças regulatórias, tecnológicas e de mercado. Você é o único responsável pelos riscos associados ao uso de carteiras, redes blockchain, taxas, contratos e ativos digitais.',
      'Podemos restringir, suspender ou recusar acesso a utilizadores localizados em jurisdições proibidas, sancionadas ou incompatíveis com as nossas obrigações legais e operacionais.'
      ,
      'O utilizador é exclusivamente responsável por verificar se pode aceder, usar carteiras, interagir com ativos digitais ou executar operações relacionadas com a plataforma segundo a legislação do local onde se encontra.'
    ]
  },
  {
    id: 'pagamentos-carteiras-saques',
    title: '12. Pagamentos, carteiras e saques',
    body: [
      'Depósitos, saques e certas compras podem depender de redes blockchain, carteiras, exploradores, RPCs e fornecedores terceiros que não controlamos.',
      'Transações on-chain podem ser irreversíveis. Se enviar ativos para o endereço, rede ou token errados, os fundos podem perder-se definitivamente. Você é responsável por conferir cada operação antes de a confirmar.',
      'Podemos rever, segurar temporariamente, rejeitar ou atrasar saques para prevenção de fraude, verificação de conta, conformidade legal, segurança operacional e proteção da plataforma.',
      'O Genesis Miner não garante prazos fixos de processamento para operações que dependam de validações internas, filas operacionais, blockchain, congestionamento de rede ou serviços de terceiros.'
    ]
  },
  {
    id: 'indicacao',
    title: '13. Programa de indicação',
    body: [
      'Regras de indicação, comissões, atribuição e critérios de elegibilidade podem ser alterados a qualquer momento conforme o produto.',
      'Auto-indicações, indicações artificiais, ciclos abusivos, compras simuladas para gerar comissão, múltiplas contas ou qualquer manipulação do sistema podem resultar em reversão de recompensas, suspensão ou encerramento permanente da conta.',
      'A atribuição de recompensas de indicação depende dos critérios definidos internamente pelo Genesis Miner, que podem incluir validação de legitimidade, risco, atividade efetiva e conformidade com regras da campanha.'
    ]
  },
  {
    id: 'sites-terceiros',
    title: '14. Sites de terceiros e publicidade',
    body: [
      'Os serviços podem conter links, integrações, anúncios, widgets, carteiras ou páginas de terceiros. Não controlamos os conteúdos, políticas, práticas, disponibilidade ou segurança desses serviços externos.',
      'O uso de serviços de terceiros é feito por sua conta e risco.',
      'A presença de link, integração ou referência a serviço externo não significa aprovação, garantia ou responsabilidade do Genesis Miner sobre esse terceiro.'
    ]
  },
  {
    id: 'alteracoes',
    title: '15. Alterações',
    body: [
      'Podemos alterar estes Termos, políticas relacionadas, regras económicas, funcionalidades e condições operacionais publicando versões atualizadas na plataforma.',
      'Quando exigido por lei, indicaremos data de entrada em vigor, aviso prévio ou outros mecanismos de comunicação adequados.',
      'A continuidade de uso da plataforma após a entrada em vigor de alterações relevantes será tratada como aceitação da versão então vigente, salvo quando a lei exigir mecanismo diferente.'
    ]
  },
  {
    id: 'comunicacoes-eletronicas',
    title: '16. Comunicações eletrónicas, registos e assinaturas',
    body: [
      'Você concorda em receber avisos, atualizações, confirmações, mensagens operacionais, recibos e documentos por meios eletrónicos, incluindo e-mail, interface da aplicação e páginas do site.',
      'Registos eletrónicos mantidos pelos nossos sistemas podem ser usados como prova de atividade, consentimentos, transações, acessos e eventos da conta, nos termos da legislação aplicável.',
      'É responsabilidade do utilizador manter e-mail válido, acesso à conta e atenção razoável às comunicações relevantes para segurança e operação do serviço.'
    ]
  },
  {
    id: 'lei-aplicavel',
    title: '17. Lei aplicável, foro, resolução informal e ações coletivas',
    body: [
      'Salvo disposição consumerista obrigatória em contrário, estes Termos são regidos pela legislação aplicável à entidade operadora do Genesis Miner.',
      'Antes de iniciar litígios formais, você concorda em tentar resolver a questão de boa-fé pelos canais oficiais de suporte durante prazo razoável, quando esse requisito for juridicamente admissível.',
      'Na máxima medida permitida por lei, litígios devem ser apresentados de forma individual e não como ação coletiva ou representativa.'
    ]
  },
  {
    id: 'sancoes-e-conformidade',
    title: '18. Sanções, controlos de exportação e programas de conformidade',
    body: [
      'Você declara que não usará a plataforma em violação de sanções económicas, controlos de exportação, normas antiboicote ou outras regras de conformidade aplicáveis.',
      'Podemos bloquear acessos, congelar funcionalidades, recusar saques, interromper transações ou encerrar contas quando exigido por lei ou quando razoavelmente entendermos que há risco de fraude, sanções ou atividade ilícita.',
      'Nenhum utilizador tem direito adquirido à manutenção de funcionalidades específicas quando sua continuidade puder expor a plataforma a risco jurídico, regulatório ou operacional relevante.'
    ]
  },
  {
    id: 'disposicoes-finais',
    title: '19. Disposições finais',
    body: [
      'Estes Termos permanecem em vigor enquanto você usar os serviços. Podemos negar acesso, bloquear IPs, restringir funcionalidades ou encerrar contas quando permitido por lei, inclusive em caso de violação destes Termos.',
      'Se alguma disposição for considerada inválida ou inexequível, as restantes continuarão válidas na máxima medida possível.',
      'Estes Termos, juntamente com a Política de Privacidade e regras específicas publicadas na plataforma, constituem o acordo integral entre você e o Genesis Miner sobre o objeto aqui tratado.',
      'O não exercício imediato de qualquer direito pelo Genesis Miner não constitui renúncia, tolerância permanente ou limitação do direito de aplicação futura.'
    ]
  },
  {
    id: 'contato',
    title: '20. Contato',
    body: [
      'Para dúvidas sobre estes Termos de Uso, utilize os canais oficiais de suporte publicados no Genesis Miner, incluindo a área de suporte dentro da plataforma e os contactos oficiais divulgados pela equipa.'
    ]
  }
];

export const TermsPage: React.FC = () => {
  return (
    <div className="max-w-5xl mx-auto px-6 py-12 text-slate-700 dark:text-slate-300 animate-in slide-in-from-bottom-4 duration-500">
      <div className="mb-10 text-center">
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white mb-4 flex items-center justify-center gap-3">
          <FileText className="text-amber-600 dark:text-amber-500" /> Termos de Uso
        </h1>
        <p className="text-slate-500 dark:text-slate-400 text-lg">
          Estes Termos de Uso regem o acesso e o uso do Genesis Miner, incluindo o site, a aplicação e os serviços relacionados.
        </p>
        <p className="mt-3 text-sm text-slate-500 dark:text-slate-500">Última atualização: 21 de maio de 2026</p>
      </div>

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 shadow-sm mb-8">
        <p className="text-sm md:text-base leading-7">
          Ao usar os Serviços, você concorda com estes Termos e com a nossa Política de Privacidade. Leia este documento com atenção antes de continuar a usar a plataforma.
        </p>
      </div>

      <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 md:p-8 mb-10">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-4">Nesta página</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className="text-amber-700 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 transition-colors"
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
