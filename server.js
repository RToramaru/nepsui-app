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

app.use(express.static('public'));
app.use(express.json());

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/processar', upload.single('fileInput'), (req, res) => {
    const filePath = req.file.path;
    const { dataParto, numLeitoes } = req.body;

    const result = processExcelFile(filePath, dataParto, numLeitoes + 1);

    res.json({
        status: 'success',
        dadosLimpos: result.dadosLimpos,
        pesosAjustados: result.pesosAjustados
    });
});


function processExcelFile(filePath, dataParto, numLeitoes) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = xlsx.utils.sheet_to_json(sheet);

    jsonData.forEach(row => {

        if (typeof row['Horário'] === 'number') {
            let hours = Math.floor(row['Horário'] * 24);
            let minutes = Math.floor((row['Horário'] * 24 - hours) * 60);
            let seconds = Math.round((((row['Horário'] * 24 - hours) * 60) - minutes) * 60);

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

    const filteredData = dataHorario.filter(row => {
        return row['Peso'] >= 100;
    });

    const groupedData = groupBy(filteredData, 'Data');
    const cleanData = Object.keys(groupedData).map(date => {
        return {
            Data: date,
            Dados: removeOutliers(groupedData[date]),
        };
    });

    const pesosAjustados = calcularPesosSegmentados(cleanData, dataParto, numLeitoes);
    const dadosBrutos = Object.keys(groupedData).map(date => {
        return {
            Data: date,
            Dados: groupedData[date],
        };
    });
    return {
        dadosLimpos: dadosBrutos,
        pesosAjustados
    };
}

function groupBy(array, key) {
    return array.reduce((result, item) => {
        (result[item[key]] = result[item[key]] || []).push(item);
        return result;
    }, {});
}

function removeOutliers(grupo, threshold = 0.01, bandwidth = 0.5) {

    const pesos = grupo.map(item => item['Peso']);
    const densityEstimator = density1d(pesos, { bandwidth });
    const densities = Array.from(densityEstimator.points()).map(point => point.y);

    return grupo.filter((_, idx) => densities[idx] > threshold);
}

function calcularPesosSegmentados(dados, dataParto, numLeitoes) {
    const pesosPorcas = [];
    const pesosPorcasELeitoes = [];
    const datas = [];

    const grupos = groupBy(dados, 'Data');


    for (let data in grupos) {
        const grupo = grupos[data];

        const pesos = grupo.flatMap(item =>
            Object.values(item['Dados']).map(dado => dado['Peso'])
        );

        const minPeso = Math.min(...pesos);
        const maxPeso = Math.max(...pesos);

        const thresholds = Array.from({ length: numLeitoes }, (_, i) =>
            minPeso + (maxPeso - minPeso) * i / numLeitoes
        );

        const bins = bin().thresholds(thresholds)(pesos);

        let pesoMaxPorcaBin = Math.max(...bins[0]);


        pesosPorcas.push(pesoMaxPorcaBin);
        pesosPorcasELeitoes.push(Math.max(...pesos));
        datas.push(data);
    }



    const pesosAjustadosPorcas = regressaoSegmentada(
        datas,
        pesosPorcas,
        moment(dataParto, 'YYYY-MM-DD').format('DD/MM/YYYY')
    ).previsoes;


    const pesosPorcasELeitoesAjustados = regressaoSegmentada(
        datas,
        pesosPorcasELeitoes,
        moment(dataParto, 'YYYY-MM-DD').format('DD/MM/YYYY')
    ).previsoes;


    const dataPartoMoment = moment(dataParto, 'YYYY-MM-DD').diff(moment(datas[0], 'DD/MM/YYYY'), 'days');


    const pesosAjustadosPorcasELeitoes = pesosPorcasELeitoesAjustados.map((peso, idx) => {
        if (idx < dataPartoMoment + 1) {
            return 0;
        }
        return peso;
    });

    const pesosAjustadosLeitoes = pesosAjustadosPorcasELeitoes.map((peso, idx) => {
        if (idx < dataPartoMoment + 1) {
            return 0;
        }
        return peso - pesosAjustadosPorcas[idx]
    });

    return {
        datas,
        pesosAjustadosPorcas,
        pesosAjustadosPorcasELeitoes,
        pesosAjustadosLeitoes,
    };

}

function regressaoSegmentada(datas, pesos, pontoRuptura) {
    const datasNumericas = datas.map(data =>
        moment(data, 'DD/MM/YYYY').diff(moment(datas[0], 'DD/MM/YYYY'), 'days')
    );

    const rupturaNumerica = moment(pontoRuptura, 'DD/MM/YYYY').diff(moment(datas[0], 'DD/MM/YYYY'), 'days');

    const datasAntes = datasNumericas.filter(dia => dia <= rupturaNumerica);
    const datasDepois = datasNumericas.filter(dia => dia > rupturaNumerica);

    const pesosAntes = pesos.slice(0, datasAntes.length);
    const pesosDepois = pesos.slice(datasAntes.length);

    const modeloAntes = new SimpleLinearRegression(datasAntes, pesosAntes);
    const coefAntes = modeloAntes.slope;
    const interceptAntes = modeloAntes.intercept;

    const modeloDepois = new SimpleLinearRegression(datasDepois, pesosDepois);
    const coefDepois = modeloDepois.slope;
    const interceptDepois = modeloDepois.intercept;

    const previsoesAntes = datasAntes.map(dia => modeloAntes.predict(dia));
    const previsoesDepois = datasDepois.map(dia => modeloDepois.predict(dia));


    const previsoes = [...previsoesAntes, ...previsoesDepois];


    return {
        previsoes,
        coefAntes,
        interceptAntes,
        coefDepois,
        interceptDepois
    };
}


app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
