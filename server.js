import express from 'express';
import multer from 'multer';
import path from 'path';
import moment from 'moment';
import { bin } from 'd3-array';
import xlsx from 'xlsx';
import { density1d, } from 'fast-kde';
import { SimpleLinearRegression } from 'ml-regression-simple-linear';



const app = express();
const port = 3000;



const upload = multer({ dest: 'uploads/' });

// Middleware para servir arquivos estáticos
app.use(express.static('public'));
app.use(express.json()); // Para lidar com o corpo JSON da requisição

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/processar', upload.single('fileInput'), (req, res) => {
    const filePath = req.file.path;
    const { dataParto, numLeitoes } = req.body; // Recebendo os dados do frontend

    const result = processExcelFile(filePath, dataParto, numLeitoes);
    
    res.json({ 
        status: 'success', 
        dadosLimpos: result.dadosLimpos, 
        pesosAjustados: result.pesosAjustados 
    });
});

// Função para processar o arquivo Excel e realizar os cálculos
function processExcelFile(filePath, dataParto, numLeitoes) {
    const workbook = xlsx.readFile(filePath); // Lê o arquivo Excel
    const sheetName = workbook.SheetNames[0]; // Obtém o nome da primeira planilha
    const sheet = workbook.Sheets[sheetName]; // Obtém os dados da planilha
    const jsonData = xlsx.utils.sheet_to_json(sheet); // Converte os dados para JSON

    // Processa os dados para usar nas análises
    jsonData.forEach(row => {

        if (typeof row['Horário'] === 'number') {
            // Convertemos a fração de dia para horas, minutos e segundos
            let hours = Math.floor(row['Horário'] * 24); // Hora
            let minutes = Math.floor((row['Horário'] * 24 - hours) * 60); // Minutos
            let seconds = Math.round((((row['Horário'] * 24 - hours) * 60) - minutes) * 60); // Segundos

            // Agora criamos o horário formatado (ex: '00:00:40')
            row['Horário'] = moment().add(hours, 'hours').add(minutes, 'minutes').add(seconds, 'seconds').format('HH:mm:ss');
        }

        row['Data'] = moment(row['Data'], 'DD/MM/YYYY').format('DD/MM/YYYY');
        row['Horário'] = moment(row['Horário'], 'HH:mm:ss').format('HH:mm:ss');
    });

    const dataHorario = jsonData.map(row => {
        return {
            ...row,
            Data_Horário: `${row['Data']} ${row['Horário']}`,
        };
    });

    // Filtra pesos maiores ou iguais a 100
    const filteredData = dataHorario.filter(row => {
        return row['Peso'] >= 100;
    });

    // Agrupa por data e remove outliers
    const groupedData = groupBy(filteredData, 'Data');

    // Limpa os dados removendo os outliers
    const cleanData = Object.keys(groupedData).map(date => {
        return {
            Data: date,
            Dados: removeOutliers(groupedData[date]),
        };
    });

    // Calcula os pesos ajustados
    const pesosAjustados = calcularPesosSegmentados(cleanData, dataParto, numLeitoes);

    // Retorna tanto os dados limpos quanto os pesos ajustados
    return {
        dadosLimpos: cleanData,
        pesosAjustados
    };
}

// Função para agrupar por data
function groupBy(array, key) {
    return array.reduce((result, item) => {
        (result[item[key]] = result[item[key]] || []).push(item);
        return result;
    }, {});
}

// Função para remover outliers
function removeOutliers(grupo, threshold = 0.01, bandwidth = 0.5) {

    const pesos = grupo.map(item => item['Peso']);
    const densityEstimator = density1d(pesos, { bandwidth });
    const densities = Array.from(densityEstimator.points()).map(point => point.y);

    return grupo.filter((_, idx) => densities[idx] > threshold);
}

// Função para calcular pesos segmentados
function calcularPesosSegmentados(dados, dataParto, numLeitoes) {
    const pesosPorcas = [];
    const pesosPorcasELeitoes = [];
    const datas = [];

    const grupos = groupBy(dados, 'Data');


    for (let data in grupos) {
        const grupo = grupos[data];

        // Extraindo todos os pesos dos itens
        const pesos = grupo.flatMap(item =>
            Object.values(item['Dados']).map(dado => dado['Peso'])
        );

        const minPeso = Math.min(...pesos);
        const maxPeso = Math.max(...pesos);

        // Criando os limites de bins (thresholds)
        const thresholds = Array.from({ length: numLeitoes + 1 }, (_, i) =>
            minPeso + (maxPeso - minPeso) * i / numLeitoes
        );

        // Criando os bins
        const bins = bin().thresholds(thresholds)(pesos);

        // Encontrar o maior peso no primeiro bin com mais de 100 elementos
        let pesoMaxPorcaBin = Math.max(...bins[0]);


        // Armazenar os resultados
        pesosPorcas.push(pesoMaxPorcaBin);
        pesosPorcasELeitoes.push(Math.max(...pesos));
        datas.push(data);
    }



    const pesosAjustadosPorcas = regressaoSegmentada(
        datas,
        pesosPorcas,
        moment(dataParto, 'YYYY-MM-DD').format('DD/MM/YYYY')
    ).previsoes;


    const dataPartoMoment = moment(dataParto, 'DD/MM/YYYY').diff(moment(datas[0], 'DD/MM/YYYY'), 'days');
    const pesosPorcasELeitoesAjustados = pesosPorcasELeitoes.map((peso, idx) => {
        return moment(datas[idx]).isBefore(dataPartoMoment) ? 0 : peso;
    });

    

    const pesosAjustadosPorcasELeitoes = regressaoSegmentada(
        datas,
        pesosPorcasELeitoesAjustados,
        moment(dataParto, 'YYYY-MM-DD').format('DD/MM/YYYY')
    ).previsoes;


    const pesosAjustadosLeitoes = pesosAjustadosPorcasELeitoes.map((peso, idx) => peso - pesosAjustadosPorcas[idx]);



    return {
        datas,
        pesosAjustadosPorcas,
        pesosAjustadosPorcasELeitoes,
        pesosAjustadosLeitoes,
    };
    
}

// Função para regressão segmentada
function regressaoSegmentada(datas, pesos, pontoRuptura) {
    // Converte as datas para números representando a quantidade de dias desde a primeira data
    const datasNumericas = datas.map(data =>
        moment(data, 'DD/MM/YYYY').diff(moment(datas[0], 'DD/MM/YYYY'), 'days')
    );

    // Encontra o ponto de ruptura
    const rupturaNumerica = moment(pontoRuptura, 'DD/MM/YYYY').diff(moment(datas[0], 'DD/MM/YYYY'), 'days');

    // Divide os dados em antes e depois do ponto de ruptura
    const datasAntes = datasNumericas.filter(dia => dia <= rupturaNumerica);
    const datasDepois = datasNumericas.filter(dia => dia > rupturaNumerica);

    const pesosAntes = pesos.slice(0, datasAntes.length);
    const pesosDepois = pesos.slice(datasAntes.length);

    // Cria o modelo de regressão para os dados antes da ruptura
    const modeloAntes = new SimpleLinearRegression(datasAntes, pesosAntes);
    const coefAntes = modeloAntes.slope;  // Coeficiente angular
    const interceptAntes = modeloAntes.intercept;  // Interceptação

    // Cria o modelo de regressão para os dados depois da ruptura
    const modeloDepois = new SimpleLinearRegression(datasDepois, pesosDepois);
    const coefDepois = modeloDepois.slope;  // Coeficiente angular
    const interceptDepois = modeloDepois.intercept;  // Interceptação

    // Realiza as previsões para os dados antes e depois da ruptura
    const previsoesAntes = datasAntes.map(dia => modeloAntes.predict(dia));
    const previsoesDepois = datasDepois.map(dia => modeloDepois.predict(dia));


    // Junta as previsões de antes e depois da ruptura
    const previsoes = [...previsoesAntes, ...previsoesDepois];


    return {
        previsoes,
        coefAntes, // Coeficiente angular antes da ruptura
        interceptAntes, // Interceptação antes da ruptura
        coefDepois, // Coeficiente angular depois da ruptura
        interceptDepois // Interceptação depois da ruptura
    };
}


// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
